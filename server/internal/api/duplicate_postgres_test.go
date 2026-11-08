package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/blob"
	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresDuplicateSharedAttachmentEndToEnd(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := pgx.Identifier{fmt.Sprintf("jiange_copy_api_%d", time.Now().UnixNano())}.Sanitize()
	defer func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+schema+" CASCADE")
		admin.Close()
	}()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	cfg.ConnConfig.RuntimeParams["application_name"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	st := &store.Postgres{Pool: pool}
	blobs := blob.NewMemory()
	s := &Server{Store: st, Blobs: blobs, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
	server := httptest.NewServer(s.Handler())
	defer server.Close()
	client := func() *http.Client { j, _ := cookiejar.New(nil); return &http.Client{Jar: j} }
	owner, guest := client(), client()
	register := func(c *http.Client, email string) store.User {
		r := post(t, c, server.URL+"/api/auth/register", map[string]string{"email": email, "name": "测试", "password": "password123"})
		defer r.Body.Close()
		var v struct {
			User store.User `json:"user"`
		}
		if err := json.NewDecoder(r.Body).Decode(&v); err != nil || r.StatusCode != 201 {
			t.Fatalf("register: %d %v", r.StatusCode, err)
		}
		return v.User
	}
	ownerUser := register(owner, "pg-copy-owner@example.test")
	_, teamSpace, err := st.CreateUser(ctx, "pg-copy-team@example.test", "团队", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guestUser := register(guest, "pg-copy-guest@example.test")
	if _, err := pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'member')`, teamSpace.ID, guestUser.ID); err != nil {
		t.Fatal(err)
	}
	resp := post(t, owner, server.URL+"/api/docs", map[string]string{"title": "共享源"})
	var source store.DocMeta
	if err := json.NewDecoder(resp.Body).Decode(&source); err != nil || resp.StatusCode != 201 {
		t.Fatalf("source: %d %v", resp.StatusCode, err)
	}
	resp.Body.Close()
	const data = "source-image"
	if err := blobs.Put(ctx, "objects/pg-copy", "image/png", []byte(data)); err != nil {
		t.Fatal(err)
	}
	f, err := st.CreateFile(ctx, store.FileMeta{DocID: source.ID, UploaderID: ownerUser.ID, Name: "photo.png", Mime: "image/png", Size: int64(len(data)), ObjectKey: "objects/pg-copy"})
	if err != nil {
		t.Fatal(err)
	}
	state, _, err := StateAtHead(ctx, st, source.ID)
	if err != nil {
		t.Fatal(err)
	}
	create := state.CreateBlock(77, collab.Root, "Z", "image")
	value := strconv.FormatInt(f.ID, 10)
	set := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: 77, Clock: state.Clock() + 1}, Block: create.ID, Key: "fileId", Value: &value}
	state.Apply(set)
	var raws []store.RawOp
	for _, op := range []collab.Op{create, set} {
		b, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatal(err)
		}
		raws = append(raws, store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: b})
	}
	if _, err := st.AppendOps(ctx, source.ID, raws); err != nil {
		t.Fatal(err)
	}
	base := server.URL + "/api/docs/" + strconv.FormatInt(source.ID, 10)
	share := send(t, owner, "PUT", base+"/shares", map[string]string{"email": guestUser.Email, "role": "view"})
	if share.StatusCode != 200 {
		t.Fatalf("share: %d", share.StatusCode)
	}
	share.Body.Close()
	resp = post(t, guest, base+"/duplicate", nil)
	defer resp.Body.Close()
	var clone store.DocMeta
	if err := json.NewDecoder(resp.Body).Decode(&clone); err != nil || resp.StatusCode != 201 {
		t.Fatalf("copy: %d %v", resp.StatusCode, err)
	}
	spaces, err := st.Workspaces(ctx, guestUser.ID)
	if err != nil || len(spaces) != 2 || spaces[0].ID != teamSpace.ID || spaces[1].OwnerID != guestUser.ID || clone.WorkspaceID != spaces[1].ID {
		t.Fatalf("destination: %+v %v", clone, err)
	}
	copyState, _, err := StateAtHead(ctx, st, clone.ID)
	if err != nil {
		t.Fatal(err)
	}
	var copiedID int64
	for _, b := range copyState.View().Blocks {
		if b.Type == "image" {
			copiedID, _ = strconv.ParseInt(b.Props["fileId"], 10, 64)
		}
	}
	if copiedID <= 0 || copiedID == f.ID {
		t.Fatalf("file was not remapped: %d", copiedID)
	}
	meta, err := st.GetFile(ctx, copiedID)
	if err != nil || meta.DocID != clone.ID || meta.ObjectKey != f.ObjectKey {
		t.Fatalf("file metadata: %+v %v", meta, err)
	}
	unshare := send(t, owner, "PUT", base+"/shares", map[string]string{"email": guestUser.Email, "role": ""})
	unshare.Body.Close()
	r, err := guest.Get(server.URL + "/api/files/" + strconv.FormatInt(copiedID, 10))
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	body, err := io.ReadAll(r.Body)
	if err != nil || r.StatusCode != 200 || string(body) != data {
		t.Fatalf("copied bytes: %d %q %v", r.StatusCode, body, err)
	}

	t.Run("copy versus delete keeps the shared object", func(t *testing.T) {
		res := post(t, owner, server.URL+"/api/docs", map[string]string{"title": "并发附件源"})
		var src store.DocMeta
		if err := json.NewDecoder(res.Body).Decode(&src); err != nil || res.StatusCode != http.StatusCreated {
			t.Fatalf("create source: %d %v", res.StatusCode, err)
		}
		res.Body.Close()
		const raceKey, raceBytes = "objects/copy-delete-race", "safe-copy-bytes"
		if err := blobs.Put(ctx, raceKey, "application/octet-stream", []byte(raceBytes)); err != nil {
			t.Fatal(err)
		}
		original, err := st.CreateFile(ctx, store.FileMeta{DocID: src.ID, UploaderID: ownerUser.ID, Name: "source.bin", Mime: "application/octet-stream", Size: int64(len(raceBytes)), ObjectKey: raceKey})
		if err != nil {
			t.Fatal(err)
		}
		entered, release := make(chan struct{}), make(chan struct{})
		released := false
		defer func() {
			if !released {
				close(release)
			}
		}()
		type copyResult struct {
			doc store.DocMeta
			err error
		}
		copyDone := make(chan copyResult, 1)
		go func() {
			doc, err := st.CopyDoc(ctx, store.DocCopy{SourceID: src.ID, UserID: ownerUser.ID, WorkspaceID: src.WorkspaceID, Title: "并发副本", FileIDs: []int64{original.ID}}, func(map[int64]int64) ([]store.RawOp, error) {
				close(entered)
				<-release
				return nil, nil
			})
			copyDone <- copyResult{doc, err}
		}()
		select {
		case <-entered:
		case <-time.After(5 * time.Second):
			t.Fatal("copy did not reach builder")
		}
		type deleteResult struct {
			status int
			err    error
		}
		deleteDone := make(chan deleteResult, 1)
		go func() {
			req, err := http.NewRequest(http.MethodDelete, server.URL+"/api/files/"+strconv.FormatInt(original.ID, 10), nil)
			if err != nil {
				deleteDone <- deleteResult{err: err}
				return
			}
			res, err := owner.Do(req)
			if err != nil {
				deleteDone <- deleteResult{err: err}
				return
			}
			res.Body.Close()
			deleteDone <- deleteResult{status: res.StatusCode}
		}()
		deadline := time.Now().Add(5 * time.Second)
		waiting := false
		for time.Now().Before(deadline) {
			select {
			case result := <-deleteDone:
				t.Fatalf("delete returned before copy committed: %+v", result)
			default:
			}
			if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE 'DELETE FROM attachments%')`, schema).Scan(&waiting); err != nil {
				t.Fatal(err)
			}
			if waiting {
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		if !waiting {
			t.Fatal("attachment deletion did not wait for the copy transaction")
		}
		close(release)
		released = true
		var copied copyResult
		select {
		case copied = <-copyDone:
		case <-time.After(5 * time.Second):
			t.Fatal("copy did not complete")
		}
		if copied.err != nil {
			t.Fatalf("copy: %v", copied.err)
		}
		select {
		case result := <-deleteDone:
			if result.err != nil || result.status != http.StatusNoContent {
				t.Fatalf("delete: %+v", result)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("delete did not complete")
		}
		var copiedFileID int64
		if err := pool.QueryRow(ctx, `SELECT id FROM attachments WHERE doc_id=$1 AND object_key=$2`, copied.doc.ID, raceKey).Scan(&copiedFileID); err != nil {
			t.Fatal(err)
		}
		copiedRes, err := owner.Get(server.URL + "/api/files/" + strconv.FormatInt(copiedFileID, 10))
		if err != nil {
			t.Fatal(err)
		}
		defer copiedRes.Body.Close()
		copiedBytes, err := io.ReadAll(copiedRes.Body)
		if err != nil || copiedRes.StatusCode != http.StatusOK || string(copiedBytes) != raceBytes {
			t.Fatalf("copied bytes: status=%d body=%q err=%v", copiedRes.StatusCode, copiedBytes, err)
		}
	})
	t.Run("delete before copy rejects the missing source", func(t *testing.T) {
		res := post(t, owner, server.URL+"/api/docs", map[string]string{"title": "已删除附件源"})
		var src store.DocMeta
		if err := json.NewDecoder(res.Body).Decode(&src); err != nil || res.StatusCode != http.StatusCreated {
			t.Fatalf("create source: %d %v", res.StatusCode, err)
		}
		res.Body.Close()
		const key = "objects/delete-before-copy"
		if err := blobs.Put(ctx, key, "application/octet-stream", []byte("payload")); err != nil {
			t.Fatal(err)
		}
		original, err := st.CreateFile(ctx, store.FileMeta{DocID: src.ID, UploaderID: ownerUser.ID, Name: "source.bin", Mime: "application/octet-stream", Size: 7, ObjectKey: key})
		if err != nil {
			t.Fatal(err)
		}
		deleteReq, err := http.NewRequest(http.MethodDelete, server.URL+"/api/files/"+strconv.FormatInt(original.ID, 10), nil)
		if err != nil {
			t.Fatal(err)
		}
		deleted, err := owner.Do(deleteReq)
		if err != nil {
			t.Fatal(err)
		}
		deleted.Body.Close()
		if deleted.StatusCode != http.StatusNoContent {
			t.Fatalf("delete: %d", deleted.StatusCode)
		}
		_, err = st.CopyDoc(ctx, store.DocCopy{SourceID: src.ID, UserID: ownerUser.ID, WorkspaceID: src.WorkspaceID, Title: "无效副本", FileIDs: []int64{original.ID}}, func(map[int64]int64) ([]store.RawOp, error) { return nil, nil })
		if !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("copy must reject deleted source: %v", err)
		}
		if _, err := blobs.Get(ctx, key); !errors.Is(err, blob.ErrNotFound) {
			t.Fatalf("last unreferenced blob was not deleted: %v", err)
		}
	})
}
