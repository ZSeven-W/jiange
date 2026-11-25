package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
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
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func newStorageQuotaTestServer(t *testing.T, st store.Store, blobs blob.Store) (*Server, *httptest.Server, *http.Client) {
	t.Helper()
	fixedNow := time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)
	s := &Server{
		Store:      st,
		Blobs:      blobs,
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL: time.Hour,
		Iterations: 1000,
		Now:        func() time.Time { return fixedNow },
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/workspaces/{wsId}/storage", s.requireUser(http.HandlerFunc(s.getWorkspaceStorage)))
	mux.Handle("PUT /api/workspaces/{wsId}/storage/quota", httpx.RequireJSON(s.requireUser(http.HandlerFunc(s.putWorkspaceStorageQuota))))
	mux.Handle("POST /api/workspaces/{wsId}/attachments/reindex", httpx.RequireJSON(s.requireUser(http.HandlerFunc(s.reindexWorkspaceAttachments))))
	mux.Handle("/", s.Handler())

	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	jar, _ := cookiejar.New(nil)
	return s, ts, &http.Client{Jar: jar}
}

func uploadMultipartFile(t *testing.T, client *http.Client, url string, filename string, data []byte, fields map[string]string, headers map[string]string) (*http.Response, []byte) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for k, v := range fields {
		if err := mw.WriteField(k, v); err != nil {
			t.Fatalf("write field %s: %v", k, err)
		}
	}
	fw, err := mw.CreateFormFile("file", filename)
	if err != nil {
		t.Fatalf("create form file: %v", err)
	}
	if _, err := fw.Write(data); err != nil {
		t.Fatalf("write form file: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close multipart: %v", err)
	}
	req, err := http.NewRequest(http.MethodPost, url, &buf)
	if err != nil {
		t.Fatalf("new upload req: %v", err)
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("X-Jiange-Upload", "1")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("upload %s: %v", url, err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp, raw
}

func TestStorageQuotaAPIAndUploadEnforcement(t *testing.T) {
	st := store.NewMemory()
	blobs := blob.NewMemory()
	_, ts, ownerClient := newStorageQuotaTestServer(t, st, blobs)
	adminClient := newCookieClient()
	memberClient := newCookieClient()
	outsiderClient := newCookieClient()
	anonClient := &http.Client{}

	owner, ws := registerAuditTestUser(t, ts, ownerClient, "sq-api-owner@example.test", "SQ Owner")
	_, _ = registerAuditTestUser(t, ts, adminClient, "sq-api-admin@example.test", "SQ Admin")
	_, _ = registerAuditTestUser(t, ts, memberClient, "sq-api-member@example.test", "SQ Member")
	_, _ = registerAuditTestUser(t, ts, outsiderClient, "sq-api-outsider@example.test", "SQ Outsider")

	joinWorkspaceAs(t, ts, ownerClient, adminClient, ws.ID, "sq-api-admin@example.test", store.WorkspaceRoleAdmin)
	joinWorkspaceAs(t, ts, ownerClient, memberClient, ws.ID, "sq-api-member@example.test", store.WorkspaceRoleMember)

	storageURL := fmt.Sprintf("%s/api/workspaces/%d/storage", ts.URL, ws.ID)
	quotaURL := fmt.Sprintf("%s/api/workspaces/%d/storage/quota", ts.URL, ws.ID)
	reindexURL := fmt.Sprintf("%s/api/workspaces/%d/attachments/reindex", ts.URL, ws.ID)

	// 1. RBAC checks: unauthenticated -> 401; regular member & outsider -> 403.
	if res := send(t, anonClient, http.MethodGet, storageURL, nil); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anon GET storage = %d, want 401", res.StatusCode)
	}
	for name, c := range map[string]*http.Client{"member": memberClient, "outsider": outsiderClient} {
		if res := send(t, c, http.MethodGet, storageURL, nil); res.StatusCode != http.StatusForbidden {
			t.Fatalf("%s GET storage = %d, want 403", name, res.StatusCode)
		}
		if res := send(t, c, http.MethodPut, quotaURL, map[string]any{"quotaBytes": 1024}); res.StatusCode != http.StatusForbidden {
			t.Fatalf("%s PUT quota = %d, want 403", name, res.StatusCode)
		}
		if res := send(t, c, http.MethodPost, reindexURL, nil); res.StatusCode != http.StatusForbidden {
			t.Fatalf("%s POST reindex = %d, want 403", name, res.StatusCode)
		}
	}

	// 2. Invalid quota payloads rejected with 400.
	if res := send(t, ownerClient, http.MethodPut, quotaURL, map[string]any{"quotaBytes": -10}); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("negative quota status = %d, want 400", res.StatusCode)
	}
	if res := send(t, ownerClient, http.MethodPut, quotaURL, map[string]any{}); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("missing quotaBytes status = %d, want 400", res.StatusCode)
	}

	// 3. Admin sets quota to 100 bytes.
	res := send(t, adminClient, http.MethodPut, quotaURL, map[string]any{"quotaBytes": 100})
	var usage store.WorkspaceStorageUsage
	if err := json.NewDecoder(res.Body).Decode(&usage); err != nil {
		t.Fatalf("decode quota response: %v", err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK || usage.QuotaBytes != 100 || usage.UsedBytes != 0 {
		t.Fatalf("PUT quota = status:%d usage:%+v", res.StatusCode, usage)
	}

	// Create a doc in ws for document attachment upload tests.
	docRes := send(t, ownerClient, http.MethodPost, ts.URL+"/api/docs", map[string]any{
		"workspaceId": ws.ID,
		"title":       "Quota Doc",
	})
	var doc store.DocMeta
	if err := json.NewDecoder(docRes.Body).Decode(&doc); err != nil {
		t.Fatalf("decode doc: %v", err)
	}
	docRes.Body.Close()
	if docRes.StatusCode != http.StatusCreated {
		t.Fatalf("create doc status = %d", docRes.StatusCode)
	}

	// 4. Upload 60-byte doc attachment -> 201 Created (used = 60 / 100).
	up1, raw1 := uploadMultipartFile(t, ownerClient, fmt.Sprintf("%s/api/docs/%d/files", ts.URL, doc.ID), "notes.txt", bytes.Repeat([]byte("a"), 60), nil, nil)
	if up1.StatusCode != http.StatusCreated {
		t.Fatalf("upload 1 status = %d body=%s", up1.StatusCode, string(raw1))
	}

	// 5. Upload 50-byte doc attachment -> exceeds 100 bytes -> 413 storage_quota_exceeded.
	up2, raw2 := uploadMultipartFile(t, ownerClient, fmt.Sprintf("%s/api/docs/%d/files", ts.URL, doc.ID), "over.txt", bytes.Repeat([]byte("b"), 50), nil, nil)
	if up2.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("upload 2 status = %d want 413, body=%s", up2.StatusCode, string(raw2))
	}
	var errBody struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(raw2, &errBody); err != nil || errBody.Error != "storage_quota_exceeded" {
		t.Fatalf("upload 2 error body = %s, want storage_quota_exceeded", string(raw2))
	}

	// 6. Drive file upload (and batch drive upload) also enforces quota -> 413 storage_quota_exceeded.
	driveOver, driveRaw := uploadMultipartFile(
		t,
		ownerClient,
		ts.URL+"/api/drive/files",
		"too-big.txt",
		bytes.Repeat([]byte("c"), 50),
		map[string]string{"workspaceId": strconv.FormatInt(ws.ID, 10)},
		map[string]string{"X-Jiange-User-Id": strconv.FormatInt(owner.ID, 10)},
	)
	if driveOver.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("drive upload over quota status = %d want 413, body=%s", driveOver.StatusCode, string(driveRaw))
	}
	if err := json.Unmarshal(driveRaw, &errBody); err != nil || errBody.Error != "storage_quota_exceeded" {
		t.Fatalf("drive over quota body = %s, want storage_quota_exceeded", string(driveRaw))
	}

	batchOver, batchRaw := uploadMultipartFile(
		t,
		ownerClient,
		ts.URL+"/api/drive/batch/files",
		"batch-too-big.txt",
		bytes.Repeat([]byte("d"), 50),
		map[string]string{"workspaceId": strconv.FormatInt(ws.ID, 10)},
		map[string]string{"X-Jiange-User-Id": strconv.FormatInt(owner.ID, 10)},
	)
	if batchOver.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("batch drive upload over quota status = %d want 413, body=%s", batchOver.StatusCode, string(batchRaw))
	}

	// 7. A 40-byte drive file fits exact remaining quota (60 + 40 = 100 <= 100) -> 201 Created.
	driveOK, driveOKRaw := uploadMultipartFile(
		t,
		ownerClient,
		ts.URL+"/api/drive/files",
		"fits.txt",
		bytes.Repeat([]byte("e"), 40),
		map[string]string{"workspaceId": strconv.FormatInt(ws.ID, 10)},
		map[string]string{"X-Jiange-User-Id": strconv.FormatInt(owner.ID, 10)},
	)
	if driveOK.StatusCode != http.StatusCreated {
		t.Fatalf("drive upload exact fit status = %d want 201, body=%s", driveOK.StatusCode, string(driveOKRaw))
	}

	// 8. Verify GET /storage reports exact usage, kind breakdown, top attachments, and index coverage.
	getRes := send(t, ownerClient, http.MethodGet, storageURL, nil)
	var snap store.WorkspaceStorageUsage
	if err := json.NewDecoder(getRes.Body).Decode(&snap); err != nil {
		t.Fatalf("decode storage usage: %v", err)
	}
	getRes.Body.Close()
	if getRes.StatusCode != http.StatusOK {
		t.Fatalf("GET storage status = %d", getRes.StatusCode)
	}
	if snap.UsedBytes != 100 || snap.QuotaBytes != 100 || snap.AttachmentCount != 2 || snap.IndexedCount != 2 {
		t.Fatalf("unexpected storage usage: %+v", snap)
	}
	if len(snap.ByKind) != 2 || len(snap.TopAttachments) != 2 {
		t.Fatalf("unexpected breakdown/top: %+v", snap)
	}

	// 9. Reset quota to 0 (unlimited) -> large upload succeeds.
	unlimRes := send(t, ownerClient, http.MethodPut, quotaURL, map[string]any{"quotaBytes": 0})
	unlimRes.Body.Close()
	if unlimRes.StatusCode != http.StatusOK {
		t.Fatalf("reset quota status = %d", unlimRes.StatusCode)
	}
	up3, raw3 := uploadMultipartFile(t, ownerClient, fmt.Sprintf("%s/api/docs/%d/files", ts.URL, doc.ID), "unlim.txt", bytes.Repeat([]byte("z"), 250), nil, nil)
	if up3.StatusCode != http.StatusCreated {
		t.Fatalf("upload after unlimited status = %d body=%s", up3.StatusCode, string(raw3))
	}

	// 10. Seed a pre-existing legacy attachment directly in store + blob (without indexing it)
	// and verify POST /attachments/reindex indexes it and emits audit logs.
	legacyText := []byte("Legacy attachment backfill keyword: ZETA-7741")
	if err := blobs.Put(context.Background(), "docs/legacy/k1", "text/plain", legacyText); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateFile(context.Background(), store.FileMeta{
		DocID:      doc.ID,
		UploaderID: owner.ID,
		Name:       "legacy-report.txt",
		Mime:       "text/plain",
		Size:       int64(len(legacyText)),
		ObjectKey:  "docs/legacy/k1",
	}); err != nil {
		t.Fatal(err)
	}

	// Before reindex: 4 attachments total, 3 indexed.
	preRes := send(t, ownerClient, http.MethodGet, storageURL, nil)
	var preUsage store.WorkspaceStorageUsage
	_ = json.NewDecoder(preRes.Body).Decode(&preUsage)
	preRes.Body.Close()
	if preUsage.AttachmentCount != 4 || preUsage.IndexedCount != 3 {
		t.Fatalf("pre-reindex usage = %+v, want count=4 indexed=3", preUsage)
	}

	reRes := send(t, adminClient, http.MethodPost, reindexURL, nil)
	var reStats AttachmentReindexStats
	if err := json.NewDecoder(reRes.Body).Decode(&reStats); err != nil {
		t.Fatalf("decode reindex stats: %v", err)
	}
	reRes.Body.Close()
	if reRes.StatusCode != http.StatusOK {
		t.Fatalf("POST reindex status = %d", reRes.StatusCode)
	}
	if reStats.WorkspaceID != ws.ID || reStats.Scanned != 4 || reStats.Indexed != 4 || reStats.Failed != 0 {
		t.Fatalf("unexpected reindex stats: %+v", reStats)
	}

	// After reindex: all 4 attachments are indexed and searchable.
	postRes := send(t, ownerClient, http.MethodGet, storageURL, nil)
	var postUsage store.WorkspaceStorageUsage
	_ = json.NewDecoder(postRes.Body).Decode(&postUsage)
	postRes.Body.Close()
	if postUsage.IndexedCount != 4 {
		t.Fatalf("post-reindex indexedCount = %d, want 4", postUsage.IndexedCount)
	}
	hits, err := st.SearchAttachmentDocIDs(context.Background(), []int64{doc.ID}, "ZETA-7741")
	if err != nil || !hits[doc.ID] {
		t.Fatalf("legacy attachment not searchable after reindex: hits=%v err=%v", hits, err)
	}

	// Verify audit trail recorded both workspace.storage_quota_updated and workspace.attachments_reindexed.
	auditRes := send(t, ownerClient, http.MethodGet, fmt.Sprintf("%s/api/workspaces/%d/audit-logs?limit=50", ts.URL, ws.ID), nil)
	var auditPage store.AuditLogPage
	_ = json.NewDecoder(auditRes.Body).Decode(&auditPage)
	auditRes.Body.Close()
	if auditRes.StatusCode != http.StatusOK {
		t.Fatalf("list audit logs status = %d", auditRes.StatusCode)
	}
	seenActions := map[string]bool{}
	for _, item := range auditPage.Items {
		seenActions[item.Action] = true
	}
	if !seenActions["workspace.storage_quota_updated"] {
		t.Fatalf("missing workspace.storage_quota_updated audit log; got %v", seenActions)
	}
	if !seenActions["workspace.attachments_reindexed"] {
		t.Fatalf("missing workspace.attachments_reindexed audit log; got %v", seenActions)
	}
}
