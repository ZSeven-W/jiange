package api

import (
	"encoding/json"
	"strconv"
	"testing"

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
