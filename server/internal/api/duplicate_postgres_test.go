package api

import (
	"context"
	"encoding/json"
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
}
