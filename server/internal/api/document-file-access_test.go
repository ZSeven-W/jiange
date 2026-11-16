package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/blob"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func referenceTestFile(t *testing.T, st store.Store, docID, fileID int64, kind string) {
	t.Helper()
	ctx := context.Background()
	doc, _, err := StateAtHead(ctx, st, docID)
	if err != nil {
		t.Fatal(err)
	}
	created := doc.CreateBlock(27, collab.Root, "Z", kind)
	value := strconv.FormatInt(fileID, 10)
	set := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: 27, Clock: doc.Clock() + 1}, Block: created.ID, Key: "fileId", Value: &value}
	var raws []store.RawOp
	for _, op := range []collab.Op{created, set} {
		encoded, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatal(err)
		}
		raws = append(raws, store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: encoded})
	}
	if _, err := st.AppendOps(ctx, docID, raws); err != nil {
		t.Fatal(err)
	}
}

func TestDocumentFileReferenceRecheckedAfterBlobOpen(t *testing.T) {
	ctx := context.Background()
	st, data := store.NewMemory(), blob.NewMemory()
	gate := &blockingFileBlob{Store: data, started: make(chan struct{}), release: make(chan struct{})}
	s := &Server{Store: st, Blobs: gate, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	client := func(email string) *http.Client {
		jar, _ := cookiejar.New(nil)
		c := &http.Client{Jar: jar}
		r := post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": email, "name": email, "password": "password123"})
		defer r.Body.Close()
		if r.StatusCode != 201 {
			t.Fatal(r.StatusCode)
		}
		return c
	}
	owner, viewer := client("ref-removal-owner@example.test"), client("ref-removal-viewer@example.test")
	r := post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "文档"})
	var meta store.DocMeta
	if err := json.NewDecoder(r.Body).Decode(&meta); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	viewerUser, err := st.UserByEmail(ctx, "ref-removal-viewer@example.test")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, meta.ID, viewerUser.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if err := data.Put(ctx, "removed/file", "application/pdf", []byte("private")); err != nil {
		t.Fatal(err)
	}
	file, err := st.CreateFile(ctx, store.FileMeta{DocID: meta.ID, Name: "附件.pdf", Mime: "application/pdf", Size: 7, ObjectKey: "removed/file"})
	if err != nil {
		t.Fatal(err)
	}
	referenceTestFile(t, st, meta.ID, file.ID, "file")
	state, _, err := StateAtHead(ctx, st, meta.ID)
	if err != nil {
		t.Fatal(err)
	}
	var target collab.OpID
	for _, block := range state.View().Blocks {
		if block.Props["fileId"] == strconv.FormatInt(file.ID, 10) {
			if _, err = fmt.Sscanf(block.ID, "%d:%d", &target.Client, &target.Clock); err != nil {
				t.Fatal(err)
			}
		}
	}
	if target == collab.Root {
		t.Fatal("missing file block")
	}
	result := make(chan *http.Response, 1)
	failure := make(chan error, 1)
	go func() {
		r, err := viewer.Get(ts.URL + "/api/files/" + strconv.FormatInt(file.ID, 10))
		if err != nil {
			failure <- err
		} else {
			result <- r
		}
	}()
	select {
	case <-gate.started:
	case <-time.After(5 * time.Second):
		t.Fatal("blob open did not start")
	}
	op := collab.Op{T: collab.TBlockDelete, ID: collab.OpID{Client: 29, Clock: state.Clock() + 1}, Block: target}
	encoded, err := collab.EncodeOps([]collab.Op{op})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = st.AppendOps(ctx, meta.ID, []store.RawOp{{ClientID: 29, Clock: int64(op.ID.Clock), Bytes: encoded}}); err != nil {
		t.Fatal(err)
	}
	close(gate.release)
	select {
	case err := <-failure:
		t.Fatal(err)
	case r := <-result:
		defer r.Body.Close()
		if r.StatusCode != 404 {
			t.Fatalf("removed while opening: %d", r.StatusCode)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("response did not finish")
	}
}

func TestDocumentFlowchartImageReference(t *testing.T) {
	ctx := context.Background()
	e := newCopyTestEnv(t)
	e.share(t)
	file := e.attach(t, e.source.ID, "flowchart", "flowchart-image", "\x89PNG\r\n\x1a\nimage", true)
	get := func() int {
		t.Helper()
		r, err := e.guest.Get(e.server.URL + "/api/files/" + strconv.FormatInt(file.ID, 10))
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		return r.StatusCode
	}
	if got := get(); got != 404 {
		t.Fatalf("unreferenced flowchart image: %d", got)
	}
	doc, _, err := StateAtHead(ctx, e.store, e.source.ID)
	if err != nil {
		t.Fatal(err)
	}
	var blockID collab.OpID
	for _, block := range doc.View().Blocks {
		if block.Type == "flowchart" {
			if _, err = fmt.Sscanf(block.ID, "%d:%d", &blockID.Client, &blockID.Clock); err != nil {
				t.Fatal(err)
			}
		}
	}
	if blockID == collab.Root {
		t.Fatal("missing flowchart")
	}
	value := fmt.Sprintf(`{"shape":"image","fileId":%d}`, file.ID)
	op := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: 28, Clock: doc.Clock() + 1}, Block: blockID, Key: "fc.n.image", Value: &value}
	encoded, err := collab.EncodeOps([]collab.Op{op})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.store.AppendOps(ctx, e.source.ID, []store.RawOp{{ClientID: 28, Clock: int64(op.ID.Clock), Bytes: encoded}}); err != nil {
		t.Fatal(err)
	}
	if got := get(); got != 200 {
		t.Fatalf("visible flowchart image: %d", got)
	}
}

func TestDocumentFileReferencesAndVersions(t *testing.T) {
	ctx := context.Background()
	e := newCopyTestEnv(t)
	e.share(t)
	png := "\x89PNG\r\n\x1a\nimage"
	image := e.attach(t, e.source.ID, "image", "historic-image", png, true)
	attachment := e.attach(t, e.source.ID, "file", "historic-attachment", png, true)
	if n, err := SweepAutomaticVersions(ctx, e.store, nil); err != nil || n != 1 {
		t.Fatalf("automatic history: %d %v", n, err)
	}
	epoch, seq, err := e.store.HeadVersion(ctx, e.source.ID)
	if err != nil {
		t.Fatal(err)
	}
	get := func(c *http.Client, file store.FileMeta, query string) int {
		t.Helper()
		response, err := c.Get(e.server.URL + "/api/files/" + strconv.FormatInt(file.ID, 10) + query)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.Header.Get("Cache-Control") != "private, no-store" {
			t.Fatalf("cache: %q", response.Header.Get("Cache-Control"))
		}
		return response.StatusCode
	}
	version := "?version=" + strconv.FormatInt(seq, 10)
	if got := get(e.guest, image, version); got != 404 {
		t.Fatalf("automatic history leaked: %d", got)
	}
	if got := get(e.owner, image, version); got != 200 {
		t.Fatalf("editor automatic history: %d", got)
	}
	body, _ := json.Marshal(map[string]any{"label": "交付版", "historyEpoch": epoch, "expectedSeq": seq, "requestId": strings.Repeat("a", 32)})
	req, _ := http.NewRequest("POST", e.url()+"/version-entries", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(e.ownerUser.ID, 10))
	resp, err := e.owner.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 201 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("save version: %d %s", resp.StatusCode, b)
	}
	resp.Body.Close()
	state, _, err := StateAtHead(ctx, e.store, e.source.ID)
	if err != nil {
		t.Fatal(err)
	}
	var deletes []store.RawOp
	clock := state.Clock()
	for _, block := range state.View().Blocks {
		if block.Props["fileId"] != strconv.FormatInt(image.ID, 10) && block.Props["fileId"] != strconv.FormatInt(attachment.ID, 10) {
			continue
		}
		var client, index uint64
		if _, err := fmt.Sscanf(block.ID, "%d:%d", &client, &index); err != nil {
			t.Fatal(err)
		}
		clock++
		op := collab.Op{T: collab.TBlockDelete, ID: collab.OpID{Client: 31, Clock: clock}, Block: collab.OpID{Client: client, Clock: index}}
		data, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatal(err)
		}
		deletes = append(deletes, store.RawOp{ClientID: 31, Clock: int64(clock), Bytes: data})
	}
	if len(deletes) != 2 {
		t.Fatalf("expected two references: %d", len(deletes))
	}
	if _, err = e.store.AppendOps(ctx, e.source.ID, deletes); err != nil {
		t.Fatal(err)
	}
	current := e.attach(t, e.source.ID, "image", "current-image", png, true)
	for _, f := range []store.FileMeta{image, attachment} {
		if got := get(e.guest, f, ""); got != 404 {
			t.Fatalf("removed %s: %d", f.ObjectKey, got)
		}
		if got := get(e.guest, f, version); got != 200 {
			t.Fatalf("saved %s: %d", f.ObjectKey, got)
		}
		if got := get(e.guest, f, "?version=1&version=2"); got != 404 {
			t.Fatalf("invalid version: %d", got)
		}
	}
	if got := get(e.guest, current, ""); got != 200 {
		t.Fatalf("current image: %d", got)
	}
	if got := get(e.guest, current, version); got != 404 {
		t.Fatalf("image not in version: %d", got)
	}
	if err := e.store.SetCopyProtected(ctx, e.source.ID, true); err != nil {
		t.Fatal(err)
	}
	if got := get(e.guest, image, version); got != 200 {
		t.Fatalf("restricted saved image: %d", got)
	}
	if got := get(e.guest, attachment, version); got != 404 {
		t.Fatalf("restricted attachment: %d", got)
	}
	if got := get(e.guest, current, ""); got != 200 {
		t.Fatalf("restricted current image: %d", got)
	}
}
