package api

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/blob"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// 云盘纵切：创建文件夹 → 列目录 → 移动 → 回收 → 恢复（guard 会话全链复验）。
func TestDriveVerticalSlice(t *testing.T) {
	ts, c := newTestServer(t, store.NewMemory(), nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "dr@x.com", "name": "DR", "password": "password123"})

	// 1) 顶层建文件夹
	var root store.DriveEntry
	if res := post(t, c, ts.URL+"/api/drive/folders", map[string]any{"title": "项目资料"}); res.StatusCode != 201 {
		t.Fatalf("create folder: %d", res.StatusCode)
	} else {
		json.NewDecoder(res.Body).Decode(&root)
	}
	if root.Kind != "folder" || root.Title != "项目资料" || root.Revision != 1 {
		t.Fatalf("root entry: %+v", root)
	}

	// 2) 空标题被拒
	if res := post(t, c, ts.URL+"/api/drive/folders", map[string]any{"title": "  "}); res.StatusCode != 400 {
		t.Fatalf("empty title accepted: %d", res.StatusCode)
	}

	// 3) 子文件夹
	var sub store.DriveEntry
	if res := post(t, c, ts.URL+"/api/drive/folders", map[string]any{"title": "2026", "parentId": root.ID}); res.StatusCode != 201 {
		t.Fatalf("create sub: %d", res.StatusCode)
	} else {
		json.NewDecoder(res.Body).Decode(&sub)
	}

	// 4) 列目录：顶层含 项目资料；子层含 2026
	var list struct{ Entries []store.DriveEntry }
	r := cGet(t, c, ts.URL+"/api/drive/children")
	json.NewDecoder(r.Body).Decode(&list)
	if len(list.Entries) == 0 || list.Entries[0].ID != root.ID {
		t.Fatalf("top children: %+v", list.Entries)
	}
	r = cGet(t, c, ts.URL+"/api/drive/children?parent="+strconv64(root.ID))
	json.NewDecoder(r.Body).Decode(&list)
	if len(list.Entries) != 1 || list.Entries[0].ID != sub.ID {
		t.Fatalf("sub children: %+v", list.Entries)
	}

	// 5) 回收子文件夹（带 revision）→ 恢复
	if res := send(t, c, "POST", ts.URL+"/api/drive/trash/"+strconv64(sub.ID), map[string]any{"expected": sub.Revision}); res.StatusCode != 204 {
		t.Fatalf("trash: %d", res.StatusCode)
	}
	r = cGet(t, c, ts.URL+"/api/drive/children?parent="+strconv64(root.ID))
	json.NewDecoder(r.Body).Decode(&list)
	if len(list.Entries) != 0 {
		t.Fatalf("after trash: %+v", list.Entries)
	}
	if res := send(t, c, "POST", ts.URL+"/api/drive/restore/"+strconv64(sub.ID), map[string]any{"expected": sub.Revision + 1}); res.StatusCode != 204 {
		t.Fatalf("restore: %d", res.StatusCode)
	}
	r = cGet(t, c, ts.URL+"/api/drive/children?parent="+strconv64(root.ID))
	json.NewDecoder(r.Body).Decode(&list)
	if len(list.Entries) != 1 || list.Entries[0].ID != sub.ID {
		t.Fatalf("after restore: %+v", list.Entries)
	}

	// 6) 过期 revision 冲突 → 409
	if res := send(t, c, "POST", ts.URL+"/api/drive/trash/"+strconv64(sub.ID), map[string]any{"expected": 999}); res.StatusCode != 409 {
		t.Fatalf("stale revision accepted: %d", res.StatusCode)
	}
}

func strconv64(v int64) string { return strconv.FormatInt(v, 10) }

// 我的空间：scope=personal 的顶层节点不进共享目录，也不泄漏到 /api/docs。
func TestDrivePersonalScope(t *testing.T) {
	ts, c := newTestServer(t, store.NewMemory(), nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "ps@x.com", "name": "PS", "password": "password123"})

	var mine store.DriveEntry
	if res := post(t, c, ts.URL+"/api/drive/folders", map[string]any{"title": "私人", "scope": "personal"}); res.StatusCode != 201 {
		t.Fatalf("personal create: %d", res.StatusCode)
	} else {
		json.NewDecoder(res.Body).Decode(&mine)
	}
	if !mine.Personal {
		t.Fatalf("personal flag: %+v", mine)
	}

	// 共享目录不含它；个人目录含它
	var list struct{ Entries []store.DriveEntry }
	json.NewDecoder(cGet(t, c, ts.URL+"/api/drive/children").Body).Decode(&list)
	if len(list.Entries) != 0 {
		t.Fatalf("shared listing leaked personal: %+v", list.Entries)
	}
	json.NewDecoder(cGet(t, c, ts.URL+"/api/drive/children?scope=personal").Body).Decode(&list)
	if len(list.Entries) != 1 || list.Entries[0].ID != mine.ID {
		t.Fatalf("personal listing: %+v", list.Entries)
	}

	// 个人空间里建文档，出现在 /api/docs（创建者本人）
	var doc store.DriveEntry
	if res := post(t, c, ts.URL+"/api/drive/nodes", map[string]any{"kind": "doc", "title": "私人文档", "parentId": mine.ID}); res.StatusCode != 201 {
		t.Fatalf("create in personal: %d", res.StatusCode)
	} else {
		json.NewDecoder(res.Body).Decode(&doc)
	}
	if !doc.Personal {
		t.Fatalf("child scope: %+v", doc)
	}
	var docs struct{ Docs []store.DocMeta }
	json.NewDecoder(cGet(t, c, ts.URL+"/api/docs").Body).Decode(&docs)
	found := false
	for _, d := range docs.Docs {
		if d.ID == doc.ID {
			found = true
		}
	}
	if !found {
		t.Fatalf("creator cannot see own personal doc: %+v", docs.Docs)
	}
}

// guarded 新建：doc/base 可直接建在文件夹内（旧创建端点会被 fence 拒绝）。
func TestDriveCreateNodesInFolder(t *testing.T) {
	ts, c := newTestServer(t, store.NewMemory(), nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "cn@x.com", "name": "CN", "password": "password123"})

	var folder store.DriveEntry
	if res := post(t, c, ts.URL+"/api/drive/folders", map[string]any{"title": "交付"}); res.StatusCode != 201 {
		t.Fatalf("create folder: %d", res.StatusCode)
	} else {
		json.NewDecoder(res.Body).Decode(&folder)
	}

	// 非法 kind
	if res := post(t, c, ts.URL+"/api/drive/nodes", map[string]any{"kind": "wiki", "title": "X", "parentId": folder.ID}); res.StatusCode != 400 {
		t.Fatalf("invalid kind accepted: %d", res.StatusCode)
	}

	var doc, base store.DriveEntry
	if res := post(t, c, ts.URL+"/api/drive/nodes", map[string]any{"kind": "doc", "title": "会议纪要", "parentId": folder.ID}); res.StatusCode != 201 {
		t.Fatalf("create doc: %d", res.StatusCode)
	} else {
		json.NewDecoder(res.Body).Decode(&doc)
	}
	if doc.Kind != "doc" || doc.Revision != 1 || doc.ParentID == nil || *doc.ParentID != folder.ID {
		t.Fatalf("doc entry: %+v", doc)
	}
	if res := post(t, c, ts.URL+"/api/drive/nodes", map[string]any{"kind": "base", "title": "跟踪表", "parentId": folder.ID}); res.StatusCode != 201 {
		t.Fatalf("create base: %d", res.StatusCode)
	} else {
		json.NewDecoder(res.Body).Decode(&base)
	}
	if base.Kind != "base" || base.Revision != 1 {
		t.Fatalf("base entry: %+v", base)
	}

	// 目录里可见两条
	var children struct{ Entries []store.DriveEntry }
	json.NewDecoder(cGet(t, c, ts.URL+"/api/drive/children?parent="+strconv64(folder.ID)).Body).Decode(&children)
	if len(children.Entries) != 2 {
		t.Fatalf("children: %+v", children.Entries)
	}

	// 建出的 doc 可通过旧文档接口读取（标题/正文路径完好）
	if res := cGet(t, c, ts.URL+"/api/docs/"+strconv64(doc.ID)); res.StatusCode != 200 {
		t.Fatalf("get created doc: %d", res.StatusCode)
	}
	// 建出的 base 有默认字段（getBase 返回 fields）
	if res := cGet(t, c, ts.URL+"/api/bases/"+strconv64(base.ID)); res.StatusCode != 200 {
		t.Fatalf("get base: %d", res.StatusCode)
	}
}

// 回收站页走旧还原端点：fence 触发器拒绝对 folder 子树的旧式 undelete，
// 端点内部必须改走 guarded RestoreDriveNode（用回收站列表带回的修订号）。
func TestTrashEndpointRestoresDriveBatch(t *testing.T) {
	ts, c := newTestServer(t, store.NewMemory(), nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "tr@x.com", "name": "TR", "password": "password123"})

	var folder store.DriveEntry
	if res := post(t, c, ts.URL+"/api/drive/folders", map[string]any{"title": "F"}); res.StatusCode != 201 {
		t.Fatalf("create folder: %d", res.StatusCode)
	} else {
		json.NewDecoder(res.Body).Decode(&folder)
	}
	var doc store.DocMeta
	json.NewDecoder(post(t, c, ts.URL+"/api/docs", map[string]string{"title": "D"}).Body).Decode(&doc)

	if res := send(t, c, "POST", ts.URL+"/api/drive/move/"+strconv64(doc.ID), map[string]any{"parentId": folder.ID, "expected": 0}); res.StatusCode != 204 {
		t.Fatalf("move into folder: %d", res.StatusCode)
	}
	if res := send(t, c, "POST", ts.URL+"/api/drive/trash/"+strconv64(doc.ID), map[string]any{"expected": 1}); res.StatusCode != 204 {
		t.Fatalf("drive trash: %d", res.StatusCode)
	}

	// 回收站列表带回 driveRevision，供乐观并发还原
	var list struct{ Docs []store.DocMeta }
	json.NewDecoder(cGet(t, c, ts.URL+"/api/trash").Body).Decode(&list)
	if len(list.Docs) != 1 || list.Docs[0].ID != doc.ID || list.Docs[0].DriveRevision != 2 || list.Docs[0].TrashBatchID == 0 {
		t.Fatalf("trash meta: %+v", list.Docs)
	}

	if res, _ := c.Post(ts.URL+"/api/trash/"+strconv64(doc.ID)+"/restore", "", nil); res.StatusCode != 204 {
		t.Fatalf("legacy endpoint restore: %d", res.StatusCode)
	}
	var children struct{ Entries []store.DriveEntry }
	json.NewDecoder(cGet(t, c, ts.URL+"/api/drive/children?parent="+strconv64(folder.ID)).Body).Decode(&children)
	if len(children.Entries) != 1 || children.Entries[0].ID != doc.ID {
		t.Fatalf("doc not back in folder: %+v", children.Entries)
	}
}

// 永久删除：回收站条目连附件对象一起清掉；不可恢复；重复清理 409。
func TestDrivePurgeReclaimsAttachmentBlobs(t *testing.T) {
	st := store.NewMemory()
	blobs := blob.NewMemory()
	srv := &Server{Store: st, Blobs: blobs, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	jar, _ := cookiejar.New(nil)
	c := &http.Client{Jar: jar}
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "pg@x.com", "name": "PG", "password": "password123"})

	var doc struct{ ID int64 }
	json.NewDecoder(post(t, c, ts.URL+"/api/docs", map[string]string{"title": "带附件"}).Body).Decode(&doc)

	// 上传附件（服务端持有对象键）
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "x.png")
	fw.Write([]byte("payload"))
	mw.Close()
	req, _ := http.NewRequest("POST", ts.URL+"/api/docs/"+strconv64(doc.ID)+"/files", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("X-Jiange-Upload", "1")
	if res, err := c.Do(req); err != nil || res.StatusCode != 201 {
		t.Fatalf("upload: %v %d", err, res.StatusCode)
	}
	full, err := st.GetFile(nil, 1)
	if err != nil {
		t.Fatal(err)
	}

	// 回收 → 永久删除 → 对象回收、条目消失、还原端点 404
	if res := send(t, c, "POST", ts.URL+"/api/drive/trash/"+strconv64(doc.ID), map[string]any{"expected": 0}); res.StatusCode != 204 {
		t.Fatalf("trash: %d", res.StatusCode)
	}
	if res := send(t, c, "POST", ts.URL+"/api/drive/purge/"+strconv64(doc.ID), map[string]any{"expected": 1}); res.StatusCode != 204 {
		t.Fatalf("purge: %d", res.StatusCode)
	}
	if _, err := blobs.Get(nil, full.ObjectKey); err != blob.ErrNotFound {
		t.Fatalf("blob outlived purge: %v", err)
	}
	var list struct{ Docs []store.DocMeta }
	json.NewDecoder(cGet(t, c, ts.URL+"/api/trash").Body).Decode(&list)
	if len(list.Docs) != 0 {
		t.Fatalf("purged subtree still in trash: %+v", list.Docs)
	}
	if res := send(t, c, "POST", ts.URL+"/api/drive/restore/"+strconv64(doc.ID), map[string]any{"expected": 1}); res.StatusCode != 409 {
		t.Fatalf("restore after purge: %d", res.StatusCode)
	}
	if res := send(t, c, "POST", ts.URL+"/api/drive/purge/"+strconv64(doc.ID), map[string]any{"expected": 1}); res.StatusCode != 409 {
		t.Fatalf("repurge: %d", res.StatusCode)
	}
}

// 重命名：guarded + 修订号；folder 走 fence 路径（drive_revision 递增）。
func TestDriveRename(t *testing.T) {
	ts, c := newTestServer(t, store.NewMemory(), nil)
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "rn@x.com", "name": "RN", "password": "password123"})

	var folder store.DriveEntry
	json.NewDecoder(post(t, c, ts.URL+"/api/drive/folders", map[string]any{"title": "原名"}).Body).Decode(&folder)
	if res := send(t, c, "POST", ts.URL+"/api/drive/rename/"+strconv64(folder.ID), map[string]any{"title": " 新名字 ", "expected": folder.Revision}); res.StatusCode != 200 {
		t.Fatalf("rename: %d", res.StatusCode)
	} else {
		var renamed store.DriveEntry
		json.NewDecoder(res.Body).Decode(&renamed)
		if renamed.Title != "新名字" || renamed.Revision != folder.Revision+1 {
			t.Fatalf("renamed: %+v", renamed)
		}
	}
	// 旧修订号 → 409
	if res := send(t, c, "POST", ts.URL+"/api/drive/rename/"+strconv64(folder.ID), map[string]any{"title": "再改", "expected": folder.Revision}); res.StatusCode != 409 {
		t.Fatalf("stale rename: %d", res.StatusCode)
	}
	// 空标题 → 400
	if res := send(t, c, "POST", ts.URL+"/api/drive/rename/"+strconv64(folder.ID), map[string]any{"title": "  ", "expected": 2}); res.StatusCode != 400 {
		t.Fatalf("empty rename: %d", res.StatusCode)
	}
}
