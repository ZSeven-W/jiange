package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/blob"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type copyTestEnv struct {
	store                  *store.Memory
	blobs                  *blob.Memory
	server                 *httptest.Server
	owner, guest           *http.Client
	ownerUser, guestUser   store.User
	ownerSpace, guestSpace store.Workspace
	source                 store.DocMeta
}

func newCopyTestEnv(t *testing.T) *copyTestEnv {
	t.Helper()
	e := &copyTestEnv{store: store.NewMemory(), blobs: blob.NewMemory()}
	s := &Server{Store: e.store, Blobs: e.blobs, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
	e.server = httptest.NewServer(s.Handler())
	t.Cleanup(e.server.Close)
	client := func() *http.Client { jar, _ := cookiejar.New(nil); return &http.Client{Jar: jar} }
	e.owner, e.guest = client(), client()
	register := func(c *http.Client, email, name string) (store.User, store.Workspace) {
		resp := post(t, c, e.server.URL+"/api/auth/register", map[string]string{"email": email, "name": name, "password": "password123"})
		defer resp.Body.Close()
		var out struct {
			User       store.User        `json:"user"`
			Workspaces []store.Workspace `json:"workspaces"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || resp.StatusCode != 201 || len(out.Workspaces) != 1 {
			t.Fatalf("register: status=%d err=%v", resp.StatusCode, err)
		}
		return out.User, out.Workspaces[0]
	}
	e.ownerUser, e.ownerSpace = register(e.owner, "copy-owner@example.test", "Owner")
	e.guestUser, e.guestSpace = register(e.guest, "copy-guest@example.test", "Guest")
	resp := post(t, e.owner, e.server.URL+"/api/docs", map[string]string{"title": "项目方案"})
	if err := json.NewDecoder(resp.Body).Decode(&e.source); err != nil || resp.StatusCode != 201 {
		t.Fatalf("source: %d %v", resp.StatusCode, err)
	}
	resp.Body.Close()
	return e
}

func (e *copyTestEnv) url() string {
	return e.server.URL + "/api/docs/" + strconv.FormatInt(e.source.ID, 10)
}
func (e *copyTestEnv) share(t *testing.T) {
	t.Helper()
	resp := send(t, e.owner, "PUT", e.url()+"/shares", map[string]string{"email": e.guestUser.Email, "role": "view"})
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("share: %d", resp.StatusCode)
	}
}
func (e *copyTestEnv) attach(t *testing.T, docID int64, typ, key, data string, persistBlob bool) store.FileMeta {
	t.Helper()
	ctx := context.Background()
	if persistBlob {
		if err := e.blobs.Put(ctx, key, "image/png", []byte(data)); err != nil {
			t.Fatal(err)
		}
	}
	f, err := e.store.CreateFile(ctx, store.FileMeta{DocID: docID, UploaderID: e.ownerUser.ID, Name: "图.png", Mime: "image/png", Size: int64(len(data)), ObjectKey: key})
	if err != nil {
		t.Fatal(err)
	}
	state, _, err := StateAtHead(ctx, e.store, docID)
	if err != nil {
		t.Fatal(err)
	}
	create := state.CreateBlock(19, collab.Root, "Z", typ)
	value := strconv.FormatInt(f.ID, 10)
	set := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: 19, Clock: state.Clock() + 1}, Block: create.ID, Key: "fileId", Value: &value}
	state.Apply(set)
	var raws []store.RawOp
	for _, op := range []collab.Op{create, set} {
		b, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatal(err)
		}
		raws = append(raws, store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: b})
	}
	if _, err := e.store.AppendOps(ctx, docID, raws); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestDuplicateSharedDocUsesAuthorizedWorkspace(t *testing.T) {
	e := newCopyTestEnv(t)
	e.share(t)
	resp := post(t, e.guest, e.url()+"/duplicate", nil)
	defer resp.Body.Close()
	var clone store.DocMeta
	if err := json.NewDecoder(resp.Body).Decode(&clone); err != nil || resp.StatusCode != 201 {
		t.Fatalf("copy status=%d err=%v", resp.StatusCode, err)
	}
	if clone.WorkspaceID != e.guestSpace.ID || clone.CreatorID != e.guestUser.ID || clone.ParentID != nil || clone.Title != "项目方案 副本" {
		t.Fatalf("copy destination: %+v", clone)
	}
	if _, err := e.store.GetDoc(context.Background(), e.guestUser.ID, clone.ID); err != nil {
		t.Fatalf("guest cannot access copy: %v", err)
	}
	resp = post(t, e.guest, e.url()+"/duplicate", map[string]int64{"workspaceId": e.ownerSpace.ID})
	defer resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatalf("foreign workspace: %d", resp.StatusCode)
	}
	resp = post(t, e.guest, e.url()+"/duplicate", map[string]any{"workspaceId": e.guestSpace.ID, "parentId": e.source.ID})
	defer resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("foreign parent: %d", resp.StatusCode)
	}
}

func TestDuplicateHonorsDefaultAndExplicitParent(t *testing.T) {
	e := newCopyTestEnv(t)
	parentResp := post(t, e.owner, e.server.URL+"/api/docs", map[string]string{"title": "父文档"})
	var parent store.DocMeta
	if err := json.NewDecoder(parentResp.Body).Decode(&parent); err != nil || parentResp.StatusCode != 201 {
		t.Fatalf("parent: %d %v", parentResp.StatusCode, err)
	}
	parentResp.Body.Close()
	childResp := post(t, e.owner, e.server.URL+"/api/docs", map[string]any{"title": "子文档", "parentId": parent.ID})
	var child store.DocMeta
	if err := json.NewDecoder(childResp.Body).Decode(&child); err != nil || childResp.StatusCode != 201 {
		t.Fatalf("child: %d %v", childResp.StatusCode, err)
	}
	childResp.Body.Close()
	url := e.server.URL + "/api/docs/" + strconv.FormatInt(child.ID, 10) + "/duplicate"
	defaultResp := post(t, e.owner, url, nil)
	var sameParent store.DocMeta
	if err := json.NewDecoder(defaultResp.Body).Decode(&sameParent); err != nil || defaultResp.StatusCode != 201 || sameParent.ParentID == nil || *sameParent.ParentID != parent.ID {
		t.Fatalf("default parent: status=%d copy=%+v err=%v", defaultResp.StatusCode, sameParent, err)
	}
	defaultResp.Body.Close()
	rootResp := post(t, e.owner, url, map[string]any{"parentId": nil})
	defer rootResp.Body.Close()
	var root store.DocMeta
	if err := json.NewDecoder(rootResp.Body).Decode(&root); err != nil || rootResp.StatusCode != 201 || root.ParentID != nil {
		t.Fatalf("explicit root: status=%d copy=%+v err=%v", rootResp.StatusCode, root, err)
	}
}

func TestDuplicateCopiesAttachmentsAndSurvivesSourceRevocation(t *testing.T) {
	e := newCopyTestEnv(t)
	e.share(t)
	image := "\x89PNG\r\n\x1a\nimage-content"
	f := e.attach(t, e.source.ID, "image", "source/image", image, true)
	resp := post(t, e.guest, e.url()+"/duplicate", nil)
	defer resp.Body.Close()
	var clone store.DocMeta
	if err := json.NewDecoder(resp.Body).Decode(&clone); err != nil || resp.StatusCode != 201 {
		t.Fatalf("copy status=%d err=%v", resp.StatusCode, err)
	}
	state, _, err := StateAtHead(context.Background(), e.store, clone.ID)
	if err != nil {
		t.Fatal(err)
	}
	var clonedID int64
	for _, block := range state.View().Blocks {
		if block.Type == "image" {
			clonedID, _ = strconv.ParseInt(block.Props["fileId"], 10, 64)
		}
	}
	if clonedID <= 0 || clonedID == f.ID {
		t.Fatalf("file ID not remapped: %d from %d", clonedID, f.ID)
	}
	meta, err := e.store.GetFile(context.Background(), clonedID)
	if err != nil || meta.DocID != clone.ID || meta.ObjectKey != f.ObjectKey {
		t.Fatalf("cloned file: %+v %v", meta, err)
	}
	send(t, e.owner, "PUT", e.url()+"/shares", map[string]string{"email": e.guestUser.Email, "role": ""}).Body.Close()
	old, err := e.guest.Get(e.server.URL + "/api/files/" + strconv.FormatInt(f.ID, 10))
	if err != nil || old.StatusCode != 404 {
		t.Fatalf("source after revoke: %v %v", old, err)
	}
	old.Body.Close()
	copied, err := e.guest.Get(e.server.URL + "/api/files/" + strconv.FormatInt(clonedID, 10))
	if err != nil {
		t.Fatal(err)
	}
	defer copied.Body.Close()
	data, err := io.ReadAll(copied.Body)
	if err != nil || copied.StatusCode != 200 || string(data) != image {
		t.Fatalf("copy file status=%d body=%q err=%v", copied.StatusCode, data, err)
	}
	copyURL := e.server.URL + "/api/docs/" + strconv.FormatInt(clone.ID, 10)
	var link store.Link
	linkResponse := send(t, e.guest, "PUT", copyURL+"/link", map[string]string{"role": "anon"})
	if err := json.NewDecoder(linkResponse.Body).Decode(&link); err != nil || linkResponse.StatusCode != 200 {
		t.Fatalf("share copy: %d %v", linkResponse.StatusCode, err)
	}
	linkResponse.Body.Close()
	publicURL := e.server.URL + "/api/public/" + link.Token + "/files/" + strconv.FormatInt(clonedID, 10)
	public, err := (&http.Client{}).Get(publicURL)
	if err != nil {
		t.Fatal(err)
	}
	defer public.Body.Close()
	publicData, err := io.ReadAll(public.Body)
	if err != nil || public.StatusCode != 200 || string(publicData) != image {
		t.Fatalf("public copy file status=%d body=%q err=%v", public.StatusCode, publicData, err)
	}
	trashed := send(t, e.owner, "DELETE", e.url(), nil)
	if trashed.StatusCode != 204 {
		t.Fatalf("trash source: %d", trashed.StatusCode)
	}
	trashed.Body.Close()
	stillPublic, err := (&http.Client{}).Get(publicURL)
	if err != nil {
		t.Fatal(err)
	}
	defer stillPublic.Body.Close()
	if stillPublic.StatusCode != 200 {
		t.Fatalf("copied file lost after source trashed: %d", stillPublic.StatusCode)
	}
}

func TestDuplicateProtectionAndMissingFilesLeaveNoPartialDoc(t *testing.T) {
	e := newCopyTestEnv(t)
	e.share(t)
	if err := e.store.SetCopyProtected(context.Background(), e.source.ID, true); err != nil {
		t.Fatal(err)
	}
	resp := post(t, e.guest, e.url()+"/duplicate", nil)
	if resp.StatusCode != 403 {
		t.Fatalf("protected source: %d", resp.StatusCode)
	}
	resp.Body.Close()
	if docs, _ := e.store.ListDocs(context.Background(), e.guestUser.ID); len(docs) != 0 {
		t.Fatalf("protected copy created: %+v", docs)
	}
	if err := e.store.SetCopyProtected(context.Background(), e.source.ID, false); err != nil {
		t.Fatal(err)
	}
	e.attach(t, e.source.ID, "file", "missing/object", "missing", false)
	resp = post(t, e.guest, e.url()+"/duplicate", nil)
	if resp.StatusCode != 409 {
		t.Fatalf("missing object: %d", resp.StatusCode)
	}
	resp.Body.Close()
	if docs, _ := e.store.ListDocs(context.Background(), e.guestUser.ID); len(docs) != 0 {
		t.Fatalf("partial copy created: %+v", docs)
	}
}

type failCopyBuildStore struct{ store.Store }

func (s failCopyBuildStore) CopyDoc(ctx context.Context, c store.DocCopy, _ store.DocCopyBuilder) (store.DocMeta, error) {
	return s.Store.CopyDoc(ctx, c, func(map[int64]int64) ([]store.RawOp, error) { return nil, errors.New("injected build error") })
}

type protectDuringCopyStore struct{ store.Store }

func (s protectDuringCopyStore) CopyDoc(ctx context.Context, c store.DocCopy, build store.DocCopyBuilder) (store.DocMeta, error) {
	if err := s.Store.SetCopyProtected(ctx, c.SourceID, true); err != nil {
		return store.DocMeta{}, err
	}
	return s.Store.CopyDoc(ctx, c, build)
}

type noPersonalWorkspaceStore struct{ store.Store }

func (s noPersonalWorkspaceStore) Workspaces(ctx context.Context, userID int64) ([]store.Workspace, error) {
	spaces, err := s.Store.Workspaces(ctx, userID)
	for i := range spaces {
		spaces[i].OwnerID = 0
	}
	return spaces, err
}

func TestDuplicateWithoutPersonalSpaceRequiresExplicitDestination(t *testing.T) {
	e := newCopyTestEnv(t)
	e.share(t)
	s := &Server{Store: noPersonalWorkspaceStore{e.store}, Blobs: e.blobs, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
	server := httptest.NewServer(s.Handler())
	defer server.Close()
	url := server.URL + "/api/docs/" + strconv.FormatInt(e.source.ID, 10) + "/duplicate"
	resp := post(t, e.guest, url, nil)
	defer resp.Body.Close()
	if resp.StatusCode != 409 {
		t.Fatalf("implicit nonpersonal destination: %d", resp.StatusCode)
	}
	if docs, _ := e.store.ListDocs(context.Background(), e.guestUser.ID); len(docs) != 0 {
		t.Fatalf("copy unexpectedly created: %+v", docs)
	}
	resp = post(t, e.guest, url, map[string]int64{"workspaceId": e.guestSpace.ID})
	defer resp.Body.Close()
	if resp.StatusCode != 201 {
		t.Fatalf("explicit authorized destination: %d", resp.StatusCode)
	}
}

func TestDuplicateRechecksProtectionAtCommit(t *testing.T) {
	e := newCopyTestEnv(t)
	e.share(t)
	wrapped := protectDuringCopyStore{e.store}
	s := &Server{Store: wrapped, Blobs: e.blobs, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
	server := httptest.NewServer(s.Handler())
	defer server.Close()
	url := server.URL + "/api/docs/" + strconv.FormatInt(e.source.ID, 10) + "/duplicate"
	resp := post(t, e.guest, url, nil)
	defer resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatalf("protection enabled during request: %d", resp.StatusCode)
	}
	if docs, _ := e.store.ListDocs(context.Background(), e.guestUser.ID); len(docs) != 0 {
		t.Fatalf("copy persisted after protection change: %+v", docs)
	}
}

func TestDuplicateDefaultTitleFitsDocumentLimit(t *testing.T) {
	e := newCopyTestEnv(t)
	longTitle := strings.Repeat("文", 200)
	state, _, err := StateAtHead(context.Background(), e.store, e.source.ID)
	if err != nil {
		t.Fatal(err)
	}
	titleBlock := collab.OpID{Client: 0, Clock: 1}
	old := state.Text(titleBlock)
	ops := state.DeleteText(19, titleBlock, 0, len([]rune(old)))
	ops = append(ops, state.InsertText(19, titleBlock, 0, longTitle))
	var raws []store.RawOp
	for _, op := range ops {
		encoded, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatal(err)
		}
		raws = append(raws, store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: encoded})
	}
	if _, err := e.store.AppendOps(context.Background(), e.source.ID, raws); err != nil {
		t.Fatal(err)
	}
	resp := post(t, e.owner, e.url()+"/duplicate", nil)
	defer resp.Body.Close()
	var clone store.DocMeta
	if err := json.NewDecoder(resp.Body).Decode(&clone); err != nil || resp.StatusCode != 201 {
		t.Fatalf("copy: %d %v", resp.StatusCode, err)
	}
	if len([]rune(clone.Title)) != 200 || !strings.HasSuffix(clone.Title, " 副本") {
		t.Fatalf("invalid copy title %q", clone.Title)
	}
}

func TestDuplicateRejectsInvalidSourceWithoutPublishingCopy(t *testing.T) {
	e := newCopyTestEnv(t)
	e.share(t)
	state, _, err := StateAtHead(context.Background(), e.store, e.source.ID)
	if err != nil {
		t.Fatal(err)
	}
	removeTitle := collab.Op{T: collab.TBlockDelete, ID: collab.OpID{Client: 19, Clock: state.Clock() + 1}, Block: collab.OpID{Client: 0, Clock: 1}}
	encoded, err := collab.EncodeOps([]collab.Op{removeTitle})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.store.AppendOps(context.Background(), e.source.ID, []store.RawOp{{ClientID: 19, Clock: int64(removeTitle.ID.Clock), Bytes: encoded}}); err != nil {
		t.Fatal(err)
	}
	resp := post(t, e.guest, e.url()+"/duplicate", nil)
	defer resp.Body.Close()
	var body struct{ Error, Message string }
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || resp.StatusCode != 409 || body.Error != "copy_unavailable" {
		t.Fatalf("invalid source: status=%d body=%+v err=%v", resp.StatusCode, body, err)
	}
	if docs, _ := e.store.ListDocs(context.Background(), e.guestUser.ID); len(docs) != 0 {
		t.Fatalf("invalid source produced a partial copy: %+v", docs)
	}
}
func TestMemoryCopyBuilderFailureIsAtomic(t *testing.T) {
	e := newCopyTestEnv(t)
	e.share(t)
	f := e.attach(t, e.source.ID, "image", "source/rollback", "content", true)
	st := failCopyBuildStore{e.store}
	_, err := st.CopyDoc(context.Background(), store.DocCopy{SourceID: e.source.ID, UserID: e.guestUser.ID, WorkspaceID: e.guestSpace.ID, FileIDs: []int64{f.ID}}, nil)
	if err == nil || !strings.Contains(err.Error(), "injected") {
		t.Fatalf("expected build error: %v", err)
	}
	if docs, _ := e.store.ListDocs(context.Background(), e.guestUser.ID); len(docs) != 0 {
		t.Fatalf("partial doc created: %+v", docs)
	}
	if _, err := e.store.GetFile(context.Background(), f.ID+1); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("partial file created: %v", err)
	}
}

type countingCopyBlob struct {
	blob.Store
	size        int64
	sizeErr     error
	gets, stats int
}

func (b *countingCopyBlob) Size(context.Context, string) (int64, error) {
	b.stats++
	return b.size, b.sizeErr
}

func (b *countingCopyBlob) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	b.gets++
	return b.Store.Get(ctx, key)
}

func TestCopyAttachmentPreflightUsesMetadataAndHandlesStorageFailure(t *testing.T) {
	e := newCopyTestEnv(t)
	f := e.attach(t, e.source.ID, "image", "source/metadata", "content", true)
	b := &countingCopyBlob{Store: e.blobs, size: f.Size}
	s := &Server{Store: e.store, Blobs: b}
	if err := s.verifyCopyFiles(context.Background(), e.source.ID, []int64{f.ID}); err != nil || b.stats != 1 || b.gets != 0 {
		t.Fatalf("metadata preflight: stats=%d gets=%d err=%v", b.stats, b.gets, err)
	}
	b.size--
	if err := s.verifyCopyFiles(context.Background(), e.source.ID, []int64{f.ID}); !errors.Is(err, errCopyAttachment) {
		t.Fatalf("length mismatch: %v", err)
	}
	b.sizeErr = context.DeadlineExceeded
	if err := s.verifyCopyFiles(context.Background(), e.source.ID, []int64{f.ID}); !errors.Is(err, errCopyStorage) {
		t.Fatalf("storage timeout: %v", err)
	}
	b.sizeErr = blob.ErrSizeUnknown
	if err := s.verifyCopyFiles(context.Background(), e.source.ID, []int64{f.ID}); err != nil || b.gets != 1 {
		t.Fatalf("stream fallback: gets=%d err=%v", b.gets, err)
	}
}

type blockingCopyBlob struct{ blob.Store }

func (b blockingCopyBlob) Size(ctx context.Context, _ string) (int64, error) {
	<-ctx.Done()
	return 0, ctx.Err()
}

func TestCopyAttachmentPreflightHonorsOverallDeadline(t *testing.T) {
	e := newCopyTestEnv(t)
	f := e.attach(t, e.source.ID, "image", "source/timeout", "content", true)
	s := &Server{Store: e.store, Blobs: blockingCopyBlob{e.blobs}}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := s.verifyCopyFiles(ctx, e.source.ID, []int64{f.ID}); !errors.Is(err, errCopyStorage) || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("deadline was not reported as storage failure: %v", err)
	}
}

func TestDuplicateRejectsTooManyDistinctAttachmentsBeforeCreatingCopy(t *testing.T) {
	e := newCopyTestEnv(t)
	e.share(t)
	state, _, err := StateAtHead(context.Background(), e.store, e.source.ID)
	if err != nil {
		t.Fatal(err)
	}
	raws := make([]store.RawOp, 0, 2*(maxCopyAttachments+1))
	for i := 1; i <= maxCopyAttachments+1; i++ {
		create := state.CreateBlock(19, collab.Root, "Z", "image")
		value := strconv.Itoa(i)
		set := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: 19, Clock: state.Clock() + 1}, Block: create.ID, Key: "fileId", Value: &value}
		state.Apply(set)
		for _, op := range []collab.Op{create, set} {
			b, err := collab.EncodeOps([]collab.Op{op})
			if err != nil {
				t.Fatal(err)
			}
			raws = append(raws, store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: b})
		}
	}
	if _, err := e.store.AppendOps(context.Background(), e.source.ID, raws[:2*maxCopyAttachments]); err != nil {
		t.Fatal(err)
	}
	// Exactly the limit passes the count gate and reaches file validation.
	atLimit := post(t, e.guest, e.url()+"/duplicate", nil)
	var atLimitBody struct{ Error string }
	if err := json.NewDecoder(atLimit.Body).Decode(&atLimitBody); err != nil || atLimit.StatusCode != http.StatusConflict || atLimitBody.Error != "invalid_attachment" {
		t.Fatalf("at-limit response: status=%d body=%+v err=%v", atLimit.StatusCode, atLimitBody, err)
	}
	atLimit.Body.Close()
	if _, err := e.store.AppendOps(context.Background(), e.source.ID, raws[2*maxCopyAttachments:]); err != nil {
		t.Fatal(err)
	}
	resp := post(t, e.guest, e.url()+"/duplicate", nil)
	defer resp.Body.Close()
	var body struct{ Error string }
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || resp.StatusCode != http.StatusUnprocessableEntity || body.Error != "copy_attachment_limit" {
		t.Fatalf("limit response: status=%d body=%+v err=%v", resp.StatusCode, body, err)
	}
	if docs, _ := e.store.ListDocs(context.Background(), e.guestUser.ID); len(docs) != 0 {
		t.Fatalf("limit failure created a partial copy: %+v", docs)
	}
}

func TestDuplicatePreservesTombstonedMarkSemanticsInInitialParagraph(t *testing.T) {
	e := newCopyTestEnv(t)
	state, _, err := StateAtHead(context.Background(), e.store, e.source.ID)
	if err != nil {
		t.Fatal(err)
	}
	paragraph := collab.OpID{Client: 0, Clock: 2}
	insert := state.InsertText(19, paragraph, 0, "ABC")
	marked := collab.OpID{Client: insert.ID.Client, Clock: insert.ID.Clock + 1}
	bold := "true"
	mark := collab.Op{T: collab.TMark, ID: collab.OpID{Client: 19, Clock: state.Clock() + 1}, Block: paragraph, Key: "bold", Value: &bold,
		Start: collab.Anchor{Char: marked, Side: 0}, End: collab.Anchor{Char: marked, Side: 1}}
	state.Apply(mark)
	ops := append([]collab.Op{insert, mark}, state.DeleteText(19, paragraph, 1, 1)...)
	var raws []store.RawOp
	for _, op := range ops {
		b, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatal(err)
		}
		raws = append(raws, store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: b})
	}
	if _, err := e.store.AppendOps(context.Background(), e.source.ID, raws); err != nil {
		t.Fatal(err)
	}
	resp := post(t, e.owner, e.url()+"/duplicate", nil)
	defer resp.Body.Close()
	var copied store.DocMeta
	if err := json.NewDecoder(resp.Body).Decode(&copied); err != nil || resp.StatusCode != 201 {
		t.Fatalf("valid formatting history should copy: status=%d err=%v", resp.StatusCode, err)
	}
	clone, _, err := StateAtHead(context.Background(), e.store, copied.ID)
	if err != nil {
		t.Fatal(err)
	}
	for offset := 0; offset <= 2; offset++ {
		original, err := collab.DecodeState(state.EncodeState())
		if err != nil {
			t.Fatal(err)
		}
		copyState, err := collab.DecodeState(clone.EncodeState())
		if err != nil {
			t.Fatal(err)
		}
		original.InsertText(31, paragraph, offset, "X")
		copyState.InsertText(32, paragraph, offset, "X")
		var got, want []collab.Span
		for _, b := range copyState.View().Blocks {
			if b.ID == "0:2" {
				got = b.Spans
			}
		}
		for _, b := range original.View().Blocks {
			if b.ID == "0:2" {
				want = b.Spans
			}
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("offset %d: got %+v want %+v", offset, got, want)
		}
	}
}
