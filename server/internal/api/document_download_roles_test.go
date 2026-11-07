package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/blob"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type pausePublicSettingsStore struct {
	store.Store
	active  atomic.Bool
	calls   atomic.Int32
	started chan struct{}
	release chan struct{}
}

// The caller may log out while a large source attachment is being checked.
// An already-authenticated request must not publish a copy after that logout.
func TestDuplicateRejectsLogoutDuringAttachmentPreflight(t *testing.T) {
	ctx := context.Background()
	st, data := store.NewMemory(), blob.NewMemory()
	gate := &blockingFileBlob{Store: data, started: make(chan struct{}), release: make(chan struct{})}
	s := &Server{Store: st, Blobs: gate, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	makeClient := func(email string) *http.Client {
		jar, _ := cookiejar.New(nil)
		c := &http.Client{Jar: jar}
		r := post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": email, "name": email, "password": "password123"})
		r.Body.Close()
		if r.StatusCode != http.StatusCreated {
			t.Fatal(r.StatusCode)
		}
		return c
	}
	owner, viewer := makeClient("copy-race-owner@example.test"), makeClient("copy-race-viewer@example.test")
	guest, err := st.UserByEmail(ctx, "copy-race-viewer@example.test")
	if err != nil {
		t.Fatal(err)
	}
	r := post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "source"})
	var doc store.DocMeta
	if err := json.NewDecoder(r.Body).Decode(&doc); err != nil || r.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %v", r.StatusCode, err)
	}
	r.Body.Close()
	url := ts.URL + "/api/docs/" + strconv.FormatInt(doc.ID, 10)
	r = send(t, owner, "PUT", url+"/shares", map[string]string{"email": "copy-race-viewer@example.test", "role": "view"})
	r.Body.Close()
	if r.StatusCode != http.StatusOK {
		t.Fatal(r.StatusCode)
	}
	if err := data.Put(ctx, "copy-preflight", "application/pdf", []byte("secret")); err != nil {
		t.Fatal(err)
	}
	file, err := st.CreateFile(ctx, store.FileMeta{DocID: doc.ID, Name: "document.pdf", Mime: "application/pdf", Size: 6, ObjectKey: "copy-preflight"})
	if err != nil {
		t.Fatal(err)
	}
	state, _, err := StateAtHead(ctx, st, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	create := state.CreateBlock(71, collab.Root, "W", "file")
	fileID := strconv.FormatInt(file.ID, 10)
	set := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: 71, Clock: create.ID.Clock + 1}, Block: create.ID, Key: "fileId", Value: &fileID}
	var ops []store.RawOp
	for _, op := range []collab.Op{create, set} {
		raw, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatal(err)
		}
		ops = append(ops, store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: raw})
	}
	if _, err := st.AppendOps(ctx, doc.ID, ops); err != nil {
		t.Fatal(err)
	}
	results, failures := make(chan *http.Response, 1), make(chan error, 1)
	go func() {
		r, err := viewer.Post(url+"/duplicate", "application/json", nil)
		if err != nil {
			failures <- err
		} else {
			results <- r
		}
	}()
	select {
	case <-gate.started:
	case <-time.After(5 * time.Second):
		t.Fatal("attachment preflight did not start")
	}
	r = post(t, viewer, ts.URL+"/api/auth/logout", nil)
	r.Body.Close()
	if r.StatusCode != http.StatusNoContent {
		close(gate.release)
		t.Fatalf("logout: %d", r.StatusCode)
	}
	close(gate.release)
	select {
	case err := <-failures:
		t.Fatal(err)
	case r := <-results:
		r.Body.Close()
		if r.StatusCode != http.StatusUnauthorized {
			t.Fatalf("copy after logout: %d", r.StatusCode)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("copy did not finish")
	}
	docs, err := st.ListDocs(ctx, guest.ID)
	if err != nil || len(docs) != 0 {
		t.Fatalf("copy must not persist after logout: %v %+v", err, docs)
	}
}

func (s *pausePublicSettingsStore) GetDocSystem(ctx context.Context, id int64) (store.DocMeta, error) {
	meta, err := s.Store.GetDocSystem(ctx, id)
	if s.active.Load() && s.calls.Add(1) == 2 {
		close(s.started)
		select {
		case <-s.release:
		case <-ctx.Done():
			return store.DocMeta{}, ctx.Err()
		}
	}
	return meta, err
}

func TestPublicDocumentRechecksLinkAfterSettingsRead(t *testing.T) {
	ctx := context.Background()
	mem := store.NewMemory()
	st := &pausePublicSettingsStore{Store: mem, started: make(chan struct{}), release: make(chan struct{})}
	s := &Server{Store: st, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	jar, _ := cookiejar.New(nil)
	owner := &http.Client{Jar: jar}
	r := post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "public-settings-race@example.test", "name": "owner", "password": "password123"})
	r.Body.Close()
	if r.StatusCode != http.StatusCreated {
		t.Fatal(r.StatusCode)
	}
	r = post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "private after revoke"})
	var doc store.DocMeta
	if err := json.NewDecoder(r.Body).Decode(&doc); err != nil || r.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %v", r.StatusCode, err)
	}
	r.Body.Close()
	url := ts.URL + "/api/docs/" + strconv.FormatInt(doc.ID, 10)
	r = send(t, owner, "PUT", url+"/link", map[string]string{"role": "anon"})
	var link store.Link
	if err := json.NewDecoder(r.Body).Decode(&link); err != nil || r.StatusCode != http.StatusOK {
		t.Fatalf("link: %d %v", r.StatusCode, err)
	}
	r.Body.Close()
	st.active.Store(true)
	results, failures := make(chan *http.Response, 1), make(chan error, 1)
	go func() {
		r, err := (&http.Client{}).Get(ts.URL + "/api/public/" + link.Token)
		if err != nil {
			failures <- err
		} else {
			results <- r
		}
	}()
	select {
	case <-st.started:
	case <-time.After(5 * time.Second):
		t.Fatal("settings read did not start")
	}
	if err := mem.SetLink(ctx, doc.ID, store.Link{Role: "none"}); err != nil {
		close(st.release)
		t.Fatal(err)
	}
	close(st.release)
	select {
	case err := <-failures:
		t.Fatal(err)
	case r := <-results:
		r.Body.Close()
		if r.StatusCode != http.StatusNotFound {
			t.Fatalf("revoked public document: %d", r.StatusCode)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("public request did not finish")
	}
}

// A document's copy-content setting must not accidentally control its
// separate download/copy-document setting, including public attachments.
func TestDocumentDownloadRoleMatrix(t *testing.T) {
	e := newCopyTestEnv(t)
	e.share(t)
	client := func(email string) *http.Client {
		jar, _ := cookiejar.New(nil)
		c := &http.Client{Jar: jar}
		res := post(t, c, e.server.URL+"/api/auth/register", map[string]string{"email": email, "name": email, "password": "password123"})
		defer res.Body.Close()
		if res.StatusCode != http.StatusCreated {
			t.Fatalf("register %s: %d", email, res.StatusCode)
		}
		return c
	}
	editor, manager := client("download-editor@example.test"), client("download-manager@example.test")
	for _, grant := range []struct{ email, role string }{{"download-editor@example.test", "edit"}, {"download-manager@example.test", "manage"}} {
		res := send(t, e.owner, "PUT", e.url()+"/shares", map[string]string{"email": grant.email, "role": grant.role})
		res.Body.Close()
		if res.StatusCode != http.StatusOK {
			t.Fatalf("grant %s: %d", grant.role, res.StatusCode)
		}
	}
	file := e.attach(t, e.source.ID, "file", "download-matrix", "test-attachment", true)
	res := send(t, e.owner, "PUT", e.url()+"/link", map[string]string{"role": "anon"})
	var link store.Link
	if err := json.NewDecoder(res.Body).Decode(&link); err != nil || res.StatusCode != http.StatusOK {
		t.Fatalf("link: status=%d err=%v", res.StatusCode, err)
	}
	res.Body.Close()
	fileURL := e.server.URL + "/api/files/" + strconv.FormatInt(file.ID, 10)
	publicURL := e.server.URL + "/api/public/" + link.Token + "/files/" + strconv.FormatInt(file.ID, 10)
	getStatus := func(c *http.Client, url string) int {
		t.Helper()
		r, err := c.Get(url)
		if err != nil {
			t.Fatal(err)
		}
		r.Body.Close()
		return r.StatusCode
	}
	for _, tc := range []struct {
		min                    string
		viewer, editor, public bool
	}{
		{"view", true, true, true}, {"edit", false, true, false}, {"manage", false, false, false},
	} {
		t.Run(tc.min, func(t *testing.T) {
			r, err := e.owner.Get(e.url())
			if err != nil {
				t.Fatal(err)
			}
			var meta store.DocMeta
			if err := json.NewDecoder(r.Body).Decode(&meta); err != nil || r.StatusCode != http.StatusOK {
				t.Fatalf("read settings: %d %v", r.StatusCode, err)
			}
			r.Body.Close()
			// The other setting is deliberately restrictive to demonstrate the
			// download decision is controlled by its own threshold.
			r = send(t, e.owner, "PATCH", e.url(), map[string]any{"copyMinRole": "manage", "downloadMinRole": tc.min, "expectedPermissionsRevision": meta.PermissionsRevision})
			r.Body.Close()
			if r.StatusCode != http.StatusOK {
				t.Fatalf("settings: %d", r.StatusCode)
			}
			publicDoc, err := (&http.Client{}).Get(e.server.URL + "/api/public/" + link.Token)
			if err != nil {
				t.Fatal(err)
			}
			var publicSettings struct {
				CopyMinRole         string `json:"copyMinRole"`
				DownloadMinRole     string `json:"downloadMinRole"`
				PermissionsRevision int64  `json:"permissionsRevision"`
			}
			if err := json.NewDecoder(publicDoc.Body).Decode(&publicSettings); err != nil || publicDoc.StatusCode != http.StatusOK {
				t.Fatalf("public document: %d %v", publicDoc.StatusCode, err)
			}
			publicDoc.Body.Close()
			if publicSettings.CopyMinRole != "manage" || publicSettings.DownloadMinRole != tc.min || publicSettings.PermissionsRevision != meta.PermissionsRevision+1 {
				t.Fatalf("public settings: %+v", publicSettings)
			}
			for _, actor := range []struct {
				name    string
				client  *http.Client
				allowed bool
			}{{"viewer", e.guest, tc.viewer}, {"editor", editor, tc.editor}, {"manager", manager, true}} {
				wantFile, wantCopy := http.StatusNotFound, http.StatusForbidden
				if actor.allowed {
					wantFile, wantCopy = http.StatusOK, http.StatusCreated
				}
				if got := getStatus(actor.client, fileURL); got != wantFile {
					t.Errorf("%s file: got %d want %d", actor.name, got, wantFile)
				}
				r := post(t, actor.client, e.url()+"/duplicate", nil)
				r.Body.Close()
				if r.StatusCode != wantCopy {
					t.Errorf("%s duplicate: got %d want %d", actor.name, r.StatusCode, wantCopy)
				}
			}
			wantPublic := http.StatusNotFound
			if tc.public {
				wantPublic = http.StatusOK
			}
			if got := getStatus(&http.Client{}, publicURL); got != wantPublic {
				t.Errorf("anonymous file: got %d want %d", got, wantPublic)
			}
		})
	}
}

// Changing the download threshold after the blob has opened must be checked
// again before the file is served, even though the user remains a reader.
func TestDocumentDownloadThresholdRecheckedAfterBlobOpen(t *testing.T) {
	ctx := context.Background()
	st, data := store.NewMemory(), blob.NewMemory()
	gate := &blockingFileBlob{Store: data, started: make(chan struct{}), release: make(chan struct{})}
	s := &Server{Store: st, Blobs: gate, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	makeClient := func(email string) *http.Client {
		jar, _ := cookiejar.New(nil)
		c := &http.Client{Jar: jar}
		r := post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": email, "name": email, "password": "password123"})
		r.Body.Close()
		if r.StatusCode != http.StatusCreated {
			t.Fatal(r.StatusCode)
		}
		return c
	}
	owner, viewer := makeClient("download-race-owner@example.test"), makeClient("download-race-viewer@example.test")
	r := post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "文档"})
	var doc store.DocMeta
	if err := json.NewDecoder(r.Body).Decode(&doc); err != nil || r.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %v", r.StatusCode, err)
	}
	r.Body.Close()
	url := ts.URL + "/api/docs/" + strconv.FormatInt(doc.ID, 10)
	r = send(t, owner, "PUT", url+"/shares", map[string]string{"email": "download-race-viewer@example.test", "role": "view"})
	r.Body.Close()
	if r.StatusCode != http.StatusOK {
		t.Fatal(r.StatusCode)
	}
	if err := data.Put(ctx, "doc-download.pdf", "application/pdf", []byte("secret")); err != nil {
		t.Fatal(err)
	}
	file, err := st.CreateFile(ctx, store.FileMeta{DocID: doc.ID, Name: "doc.pdf", Mime: "application/pdf", Size: 6, ObjectKey: "doc-download.pdf"})
	if err != nil {
		t.Fatal(err)
	}
	results, failures := make(chan *http.Response, 1), make(chan error, 1)
	go func() {
		response, err := viewer.Get(ts.URL + "/api/files/" + strconv.FormatInt(file.ID, 10))
		if err != nil {
			failures <- err
		} else {
			results <- response
		}
	}()
	select {
	case <-gate.started:
	case <-time.After(5 * time.Second):
		t.Fatal("blob open did not start")
	}
	r = send(t, owner, "PATCH", url, map[string]any{"downloadMinRole": "edit", "expectedPermissionsRevision": doc.PermissionsRevision})
	r.Body.Close()
	if r.StatusCode != http.StatusOK {
		close(gate.release)
		t.Fatalf("change threshold: %d", r.StatusCode)
	}
	close(gate.release)
	select {
	case err := <-failures:
		t.Fatal(err)
	case got := <-results:
		got.Body.Close()
		if got.StatusCode != http.StatusNotFound {
			t.Fatalf("download after threshold change: %d", got.StatusCode)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("file request did not finish")
	}
}

func TestDocumentPermissionSettingsRejectInvalidAndStaleChanges(t *testing.T) {
	e := newCopyTestEnv(t)
	// Editors must not be able to smuggle a title update alongside a denied
	// permission change.
	r := send(t, e.owner, "PUT", e.url()+"/shares", map[string]string{"email": e.guestUser.Email, "role": "edit"})
	r.Body.Close()
	if r.StatusCode != http.StatusOK {
		t.Fatalf("share: %d", r.StatusCode)
	}
	check := func(client *http.Client, body map[string]any, want int) {
		t.Helper()
		res := send(t, client, "PATCH", e.url(), body)
		res.Body.Close()
		if res.StatusCode != want {
			t.Fatalf("patch %v: got %d want %d", body, res.StatusCode, want)
		}
	}
	check(e.guest, map[string]any{"downloadMinRole": "edit", "expectedPermissionsRevision": 0, "title": "must not change"}, http.StatusForbidden)
	check(e.owner, map[string]any{"downloadMinRole": "admin", "expectedPermissionsRevision": 0}, http.StatusBadRequest)
	check(e.owner, map[string]any{"downloadMinRole": "edit"}, http.StatusBadRequest)
	check(e.owner, map[string]any{"downloadMinRole": "edit", "copyProtected": true, "expectedPermissionsRevision": 0}, http.StatusBadRequest)
	check(e.owner, map[string]any{"downloadMinRole": "edit", "expectedPermissionsRevision": 0}, http.StatusOK)
	check(e.owner, map[string]any{"downloadMinRole": "view", "expectedPermissionsRevision": 1}, http.StatusOK)
	// The value is back to view, but the old revision must still conflict.
	check(e.owner, map[string]any{"downloadMinRole": "manage", "expectedPermissionsRevision": 0}, http.StatusConflict)
	r, err := e.owner.Get(e.url())
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	var meta store.DocMeta
	if err := json.NewDecoder(r.Body).Decode(&meta); err != nil || r.StatusCode != http.StatusOK {
		t.Fatalf("read: %d %v", r.StatusCode, err)
	}
	if meta.Title != e.source.Title || meta.DownloadMinRole != "view" || meta.PermissionsRevision != 2 {
		t.Fatalf("unexpected state after denied changes: %+v", meta)
	}
}
