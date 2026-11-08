package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/blob"
	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func exerciseDriveFile(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	blobs := blob.NewMemory()
	srv := &Server{Store: st, Blobs: blobs, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	client := func() *http.Client { jar, _ := cookiejar.New(nil); return &http.Client{Jar: jar} }
	owner, outsider := client(), client()
	for i, c := range []*http.Client{owner, outsider} {
		res := post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": fmt.Sprintf("drive-file-%d@example.test", i), "name": "测试", "password": "password123"})
		res.Body.Close()
		if res.StatusCode != 201 {
			t.Fatalf("register: %d", res.StatusCode)
		}
	}
	var folder store.DriveEntry
	res := post(t, owner, ts.URL+"/api/drive/folders", map[string]any{"title": "项目资料", "scope": "personal"})
	if err := json.NewDecoder(res.Body).Decode(&folder); err != nil || res.StatusCode != 201 {
		t.Fatalf("folder: %d %v", res.StatusCode, err)
	}
	res.Body.Close()
	res = send(t, owner, http.MethodPut, ts.URL+"/api/docs/"+strconv.FormatInt(folder.ID, 10)+"/shares", map[string]string{"email": "drive-file-1@example.test", "role": "view"})
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("share folder for read: %d", res.StatusCode)
	}
	var forbiddenUpload bytes.Buffer
	forbiddenForm := multipart.NewWriter(&forbiddenUpload)
	_ = forbiddenForm.WriteField("parentId", strconv.FormatInt(folder.ID, 10))
	forbiddenPart, err := forbiddenForm.CreateFormFile("file", "blocked.txt")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = forbiddenPart.Write([]byte("blocked"))
	_ = forbiddenForm.Close()
	forbiddenReq, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/drive/files", &forbiddenUpload)
	forbiddenReq.Header.Set("Content-Type", forbiddenForm.FormDataContentType())
	forbiddenReq.Header.Set("X-Jiange-Upload", "1")
	res, err = outsider.Do(forbiddenReq)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("viewer uploaded into shared folder: %d", res.StatusCode)
	}
	res = send(t, owner, http.MethodPut, ts.URL+"/api/docs/"+strconv.FormatInt(folder.ID, 10)+"/shares", map[string]string{"email": "drive-file-1@example.test", "role": ""})
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("revoke folder share: %d", res.StatusCode)
	}
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	_ = form.WriteField("parentId", strconv.FormatInt(folder.ID, 10))
	part, err := form.CreateFormFile("file", "计划.txt")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write([]byte("示例文件内容"))
	_ = form.Close()
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/drive/files", &body)
	req.Header.Set("Content-Type", form.FormDataContentType())
	req.Header.Set("X-Jiange-Upload", "1")
	res, err = owner.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var file store.DriveEntry
	if err := json.NewDecoder(res.Body).Decode(&file); err != nil || res.StatusCode != 201 {
		t.Fatalf("upload: %d %v", res.StatusCode, err)
	}
	res.Body.Close()
	if file.Kind != "file" || !file.Personal || file.ParentID == nil || *file.ParentID != folder.ID {
		t.Fatalf("bad file node: %+v", file)
	}
	res = send(t, owner, http.MethodPatch, ts.URL+"/api/docs/"+strconv.FormatInt(file.ID, 10), map[string]any{"title": "旧接口修改"})
	res.Body.Close()
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("legacy file rename accepted: %d", res.StatusCode)
	}
	res = send(t, owner, http.MethodDelete, ts.URL+"/api/docs/"+strconv.FormatInt(file.ID, 10), nil)
	res.Body.Close()
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("legacy file trash accepted: %d", res.StatusCode)
	}
	res = post(t, owner, ts.URL+"/api/docs", map[string]any{"title": "不能创建在文件下", "parentId": file.ID})
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("file node accepted a document child: %d", res.StatusCode)
	}
	if pg, ok := st.(*store.Postgres); ok {
		if _, err := pg.CreateDoc(ctx, file.WorkspaceID, file.CreatorID, &file.ID, "legacy child", nil); err == nil {
			t.Fatal("database allowed legacy insert under a file")
		}
		if _, err := pg.UpdateTitle(ctx, file.ID, "legacy rename"); err == nil {
			t.Fatal("database allowed unversioned file rename")
		}
		if err := pg.Trash(ctx, file.ID); err == nil {
			t.Fatal("database allowed unversioned file trash")
		}
	}
	res = cGet(t, owner, ts.URL+"/api/search?q=%E8%AE%A1%E5%88%92")
	var search struct{ Docs []store.DocMeta }
	if err := json.NewDecoder(res.Body).Decode(&search); err != nil || res.StatusCode != 200 || len(search.Docs) != 1 || search.Docs[0].ID != file.ID {
		t.Fatalf("search file: %d %+v %v", res.StatusCode, search, err)
	}
	res.Body.Close()
	// Also verify the database fence for a root-level file: the existing folder
	// fence alone would reject children in the nested case above.
	res = send(t, owner, http.MethodPost, ts.URL+"/api/drive/move/"+strconv.FormatInt(file.ID, 10), map[string]any{"parentId": nil, "expected": file.Revision})
	res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("move file to root: %d", res.StatusCode)
	}
	file.Revision++
	if pg, ok := st.(*store.Postgres); ok {
		if _, err := pg.CreateDoc(ctx, file.WorkspaceID, file.CreatorID, &file.ID, "legacy root child", nil); err == nil {
			t.Fatal("database allowed legacy insert under a root-level file")
		}
	}
	res = send(t, owner, http.MethodPost, ts.URL+"/api/drive/move/"+strconv.FormatInt(file.ID, 10), map[string]any{"parentId": folder.ID, "expected": file.Revision})
	res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("move file back to folder: %d", res.StatusCode)
	}
	file.Revision++
	res = cGet(t, owner, ts.URL+"/api/drive/files/"+strconv.FormatInt(file.ID, 10))
	var meta store.FileMeta
	if err := json.NewDecoder(res.Body).Decode(&meta); err != nil || res.StatusCode != 200 {
		t.Fatalf("metadata: %d %v", res.StatusCode, err)
	}
	res.Body.Close()
	if meta.DocID != file.ID || meta.Name != "计划.txt" || !meta.Personal {
		t.Fatalf("bad metadata: %+v", meta)
	}
	if _, _, err := st.DeleteFile(ctx, meta.ID); err == nil {
		t.Fatal("store allowed deletion of a live drive file attachment")
	}
	res = cGet(t, owner, ts.URL+"/api/drive/children?parent="+strconv.FormatInt(folder.ID, 10))
	var listing struct{ Entries []store.DriveEntry }
	if err := json.NewDecoder(res.Body).Decode(&listing); err != nil || res.StatusCode != 200 || len(listing.Entries) != 1 || listing.Entries[0].ID != file.ID {
		t.Fatalf("folder listing: %d %+v %v", res.StatusCode, listing, err)
	}
	res.Body.Close()
	res = cGet(t, owner, ts.URL+"/api/files/"+strconv.FormatInt(meta.ID, 10))
	data, err := io.ReadAll(res.Body)
	res.Body.Close()
	if err != nil || res.StatusCode != 200 || string(data) != "示例文件内容" {
		t.Fatalf("download: %d %q %v", res.StatusCode, data, err)
	}
	res = cGet(t, outsider, ts.URL+"/api/drive/files/"+strconv.FormatInt(file.ID, 10))
	res.Body.Close()
	if res.StatusCode != 404 {
		t.Fatalf("metadata leaked: %d", res.StatusCode)
	}
	res = cGet(t, outsider, ts.URL+"/api/files/"+strconv.FormatInt(meta.ID, 10))
	res.Body.Close()
	if res.StatusCode == 200 {
		t.Fatal("file bytes leaked")
	}
	res = send(t, owner, http.MethodPut, ts.URL+"/api/docs/"+strconv.FormatInt(file.ID, 10)+"/link", map[string]string{"role": "anon"})
	res.Body.Close()
	if res.StatusCode != 400 {
		t.Fatalf("anonymous file share should be rejected: %d", res.StatusCode)
	}
	res = send(t, owner, http.MethodPut, ts.URL+"/api/docs/"+strconv.FormatInt(file.ID, 10)+"/shares", map[string]string{"email": "drive-file-1@example.test", "role": "view"})
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("share file: %d", res.StatusCode)
	}
	res = cGet(t, outsider, ts.URL+"/api/files/"+strconv.FormatInt(meta.ID, 10))
	data, err = io.ReadAll(res.Body)
	res.Body.Close()
	if err != nil || res.StatusCode != 200 || string(data) != "示例文件内容" {
		t.Fatalf("shared file: %d %q %v", res.StatusCode, data, err)
	}
	res = send(t, owner, http.MethodPut, ts.URL+"/api/docs/"+strconv.FormatInt(file.ID, 10)+"/shares", map[string]string{"email": "drive-file-1@example.test", "role": ""})
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("revoke file: %d", res.StatusCode)
	}
	res = cGet(t, outsider, ts.URL+"/api/files/"+strconv.FormatInt(meta.ID, 10))
	res.Body.Close()
	if res.StatusCode == 200 {
		t.Fatal("revoked user retained file access")
	}
	res = send(t, owner, http.MethodPut, ts.URL+"/api/docs/"+strconv.FormatInt(file.ID, 10)+"/link", map[string]string{"role": "view"})
	var link store.Link
	if err := json.NewDecoder(res.Body).Decode(&link); err != nil || res.StatusCode != http.StatusOK || link.Token == "" {
		t.Fatalf("enable link: %d %+v %v", res.StatusCode, link, err)
	}
	res.Body.Close()
	res = post(t, outsider, ts.URL+"/api/share/"+link.Token, nil)
	var joined store.DocMeta
	if err := json.NewDecoder(res.Body).Decode(&joined); err != nil || res.StatusCode != http.StatusOK || joined.ID != file.ID || joined.Kind != "file" {
		t.Fatalf("join file link: %d %+v %v", res.StatusCode, joined, err)
	}
	res.Body.Close()
	res = cGet(t, outsider, ts.URL+"/api/files/"+strconv.FormatInt(meta.ID, 10))
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("joined user cannot download: %d", res.StatusCode)
	}
	res = send(t, owner, http.MethodPut, ts.URL+"/api/docs/"+strconv.FormatInt(file.ID, 10)+"/link", map[string]string{"role": "none"})
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("close file link: %d", res.StatusCode)
	}
	res = cGet(t, outsider, ts.URL+"/api/files/"+strconv.FormatInt(meta.ID, 10))
	res.Body.Close()
	if res.StatusCode == http.StatusOK {
		t.Fatal("closing the link did not revoke file access")
	}
	res = send(t, owner, http.MethodDelete, ts.URL+"/api/files/"+strconv.FormatInt(meta.ID, 10), nil)
	res.Body.Close()
	if res.StatusCode != 409 {
		t.Fatalf("standalone attachment deletion: %d", res.StatusCode)
	}
	res = send(t, owner, http.MethodPost, ts.URL+"/api/drive/rename/"+strconv.FormatInt(file.ID, 10), map[string]any{"title": "bad/name", "expected": file.Revision})
	res.Body.Close()
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("invalid file name accepted: %d", res.StatusCode)
	}
	res = send(t, owner, http.MethodPost, ts.URL+"/api/drive/rename/"+strconv.FormatInt(file.ID, 10), map[string]any{"title": "修改后.txt", "expected": file.Revision})
	var renamed store.DriveEntry
	if err := json.NewDecoder(res.Body).Decode(&renamed); err != nil || res.StatusCode != 200 {
		t.Fatalf("rename: %d %v", res.StatusCode, err)
	}
	res.Body.Close()
	file = renamed
	res = cGet(t, owner, ts.URL+"/api/drive/files/"+strconv.FormatInt(file.ID, 10))
	if err := json.NewDecoder(res.Body).Decode(&meta); err != nil || meta.Name != "修改后.txt" {
		t.Fatalf("renamed file metadata: %+v %v", meta, err)
	}
	res.Body.Close()
	res = post(t, owner, ts.URL+"/api/drive/folders", map[string]any{"title": "归档", "scope": "personal"})
	var destination store.DriveEntry
	if err := json.NewDecoder(res.Body).Decode(&destination); err != nil || res.StatusCode != 201 {
		t.Fatalf("destination: %d %v", res.StatusCode, err)
	}
	res.Body.Close()
	res = send(t, owner, http.MethodPost, ts.URL+"/api/drive/move/"+strconv.FormatInt(file.ID, 10), map[string]any{"parentId": destination.ID, "expected": file.Revision})
	res.Body.Close()
	if res.StatusCode != 204 {
		t.Fatalf("move file: %d", res.StatusCode)
	}
	file.Revision++
	res = cGet(t, owner, ts.URL+"/api/drive/children?parent="+strconv.FormatInt(destination.ID, 10))
	listing.Entries = nil
	if err := json.NewDecoder(res.Body).Decode(&listing); err != nil || res.StatusCode != 200 || len(listing.Entries) != 1 || listing.Entries[0].ID != file.ID {
		t.Fatalf("moved file: %d %+v %v", res.StatusCode, listing, err)
	}
	res.Body.Close()
	res = send(t, owner, http.MethodPost, ts.URL+"/api/drive/trash/"+strconv.FormatInt(file.ID, 10), map[string]any{"expected": file.Revision})
	res.Body.Close()
	if res.StatusCode != 204 {
		t.Fatalf("trash: %d", res.StatusCode)
	}
	if _, _, err := st.DeleteFile(ctx, meta.ID); err == nil {
		t.Fatal("store allowed deletion of a recoverable drive file attachment")
	}
	res = cGet(t, owner, ts.URL+"/api/drive/files/"+strconv.FormatInt(file.ID, 10))
	res.Body.Close()
	if res.StatusCode != 404 {
		t.Fatalf("trashed file accessible: %d", res.StatusCode)
	}
	res = send(t, owner, http.MethodPost, ts.URL+"/api/drive/restore/"+strconv.FormatInt(file.ID, 10), map[string]any{"expected": file.Revision + 1})
	res.Body.Close()
	if res.StatusCode != 204 {
		t.Fatalf("restore: %d", res.StatusCode)
	}
	res = cGet(t, owner, ts.URL+"/api/files/"+strconv.FormatInt(meta.ID, 10))
	data, err = io.ReadAll(res.Body)
	res.Body.Close()
	if err != nil || res.StatusCode != 200 || string(data) != "示例文件内容" {
		t.Fatalf("restore bytes: %d %q %v", res.StatusCode, data, err)
	}
	full, err := st.GetFile(ctx, meta.ID)
	if err != nil {
		t.Fatal(err)
	}
	res = send(t, owner, http.MethodPost, ts.URL+"/api/drive/trash/"+strconv.FormatInt(file.ID, 10), map[string]any{"expected": file.Revision + 2})
	res.Body.Close()
	if res.StatusCode != 204 {
		t.Fatalf("trash again: %d", res.StatusCode)
	}
	res = send(t, owner, http.MethodPost, ts.URL+"/api/drive/purge/"+strconv.FormatInt(file.ID, 10), map[string]any{"expected": file.Revision + 3})
	res.Body.Close()
	if res.StatusCode != 204 {
		t.Fatalf("purge: %d", res.StatusCode)
	}
	if _, err = blobs.Get(ctx, full.ObjectKey); err != blob.ErrNotFound {
		t.Fatalf("purge did not delete blob: %v", err)
	}
	// Cascading a folder purge must still reclaim a child file's attachment.
	res = post(t, owner, ts.URL+"/api/drive/folders", map[string]any{"title": "待清理", "scope": "personal"})
	var tree store.DriveEntry
	if err := json.NewDecoder(res.Body).Decode(&tree); err != nil || res.StatusCode != 201 {
		t.Fatalf("create tree: %d %v", res.StatusCode, err)
	}
	res.Body.Close()
	var upload bytes.Buffer
	mw := multipart.NewWriter(&upload)
	_ = mw.WriteField("parentId", strconv.FormatInt(tree.ID, 10))
	child, err := mw.CreateFormFile("file", "child.txt")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = child.Write([]byte("child"))
	_ = mw.Close()
	childReq, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/drive/files", &upload)
	childReq.Header.Set("Content-Type", mw.FormDataContentType())
	childReq.Header.Set("X-Jiange-Upload", "1")
	res, err = owner.Do(childReq)
	if err != nil {
		t.Fatal(err)
	}
	var childNode store.DriveEntry
	if err := json.NewDecoder(res.Body).Decode(&childNode); err != nil || res.StatusCode != 201 {
		t.Fatalf("upload child: %d %v", res.StatusCode, err)
	}
	res.Body.Close()
	childMeta, err := st.GetDriveFile(ctx, file.CreatorID, childNode.ID)
	if err != nil {
		t.Fatal(err)
	}
	res = send(t, owner, http.MethodPost, ts.URL+"/api/drive/trash/"+strconv.FormatInt(tree.ID, 10), map[string]any{"expected": tree.Revision})
	res.Body.Close()
	if res.StatusCode != 204 {
		t.Fatalf("trash folder: %d", res.StatusCode)
	}
	res = send(t, owner, http.MethodPost, ts.URL+"/api/drive/purge/"+strconv.FormatInt(tree.ID, 10), map[string]any{"expected": tree.Revision + 1})
	res.Body.Close()
	if res.StatusCode != 204 {
		t.Fatalf("purge folder: %d", res.StatusCode)
	}
	if _, err := blobs.Get(ctx, childMeta.ObjectKey); err != blob.ErrNotFound {
		t.Fatalf("purge folder left child blob: %v", err)
	}
}
func TestMemoryDriveFile(t *testing.T) { exerciseDriveFile(t, store.NewMemory()) }

type committedDriveFileError struct{ store.Store }

func (s committedDriveFileError) CreateDriveFile(ctx context.Context, guard store.RestoreGuard, ws int64, parent *int64, file store.FileMeta, personal bool) (store.DriveEntry, error) {
	if _, err := s.Store.CreateDriveFile(ctx, guard, ws, parent, file, personal); err != nil {
		return store.DriveEntry{}, err
	}
	return store.DriveEntry{}, errors.New("injected ambiguous commit result")
}

func TestDriveFileAmbiguousCommitRetainsBlob(t *testing.T) {
	st := committedDriveFileError{store.NewMemory()}
	blobs := blob.NewMemory()
	srv := &Server{Store: st, Blobs: blobs, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}
	reg := post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "ambiguous-upload@example.test", "name": "测试", "password": "password123"})
	reg.Body.Close()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	_ = form.WriteField("scope", "personal")
	part, err := form.CreateFormFile("file", "safe.txt")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write([]byte("keep me"))
	_ = form.Close()
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/drive/files", &body)
	req.Header.Set("Content-Type", form.FormDataContentType())
	req.Header.Set("X-Jiange-Upload", "1")
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusInternalServerError {
		t.Fatalf("ambiguous result: %d", res.StatusCode)
	}
	res = cGet(t, client, ts.URL+"/api/drive/children?scope=personal")
	var listing struct{ Entries []store.DriveEntry }
	if err := json.NewDecoder(res.Body).Decode(&listing); err != nil || len(listing.Entries) != 1 {
		t.Fatalf("committed file not visible: %+v %v", listing, err)
	}
	res.Body.Close()
	res = cGet(t, client, ts.URL+"/api/drive/files/"+strconv.FormatInt(listing.Entries[0].ID, 10))
	var f store.FileMeta
	if err := json.NewDecoder(res.Body).Decode(&f); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	res = cGet(t, client, ts.URL+"/api/files/"+strconv.FormatInt(f.ID, 10))
	data, err := io.ReadAll(res.Body)
	res.Body.Close()
	if err != nil || res.StatusCode != 200 || string(data) != "keep me" {
		t.Fatalf("committed object was lost: %d %q %v", res.StatusCode, data, err)
	}
}

func TestPostgresDriveFile(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := pgx.Identifier{fmt.Sprintf("drive_file_%d", time.Now().UnixNano())}.Sanitize()
	defer func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+schema+" CASCADE")
		admin.Close()
	}()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err = migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	exerciseDriveFile(t, &store.Postgres{Pool: pool})
}
