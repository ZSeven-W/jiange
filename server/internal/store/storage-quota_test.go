package store_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func exerciseStorageQuotaStore(t *testing.T, st store.Store, sqs store.StorageQuotaStore, ats store.AttachmentTextStore, als store.AuditLogStore) {
	t.Helper()
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	sessionHash := []byte("storage-quota-test-session-hash")

	owner, ws1, err := st.CreateUser(ctx, "sq-owner@example.test", "Quota Owner", "hash")
	if err != nil {
		t.Fatalf("CreateUser owner: %v", err)
	}
	if err := st.CreateSession(ctx, sessionHash, owner.ID, now.Add(time.Hour)); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	guard := store.RestoreGuard{
		UserID:      owner.ID,
		SessionHash: sessionHash,
		Now:         func() time.Time { return now },
	}

	otherUser, ws2, err := st.CreateUser(ctx, "sq-other@example.test", "Other User", "hash")
	if err != nil {
		t.Fatalf("CreateUser other: %v", err)
	}

	// Non-existent workspace returns ErrNotFound.
	if _, err := sqs.GetWorkspaceStorageUsage(ctx, 999999); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing ws usage err = %v, want ErrNotFound", err)
	}
	if _, _, err := sqs.GetWorkspaceStorageQuota(ctx, 999999); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing ws quota err = %v, want ErrNotFound", err)
	}
	if err := sqs.SetWorkspaceStorageQuota(ctx, 999999, 1024, owner.ID, now); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing ws set quota err = %v, want ErrNotFound", err)
	}
	if err := sqs.SetWorkspaceStorageQuota(ctx, ws1.ID, -1, owner.ID, now); !errors.Is(err, store.ErrInvalidInput) {
		t.Fatalf("negative quota err = %v, want ErrInvalidInput", err)
	}

	// Empty workspace reports zeroes and non-nil slices.
	empty, err := sqs.GetWorkspaceStorageUsage(ctx, ws1.ID)
	if err != nil {
		t.Fatalf("empty usage: %v", err)
	}
	if empty.WorkspaceID != ws1.ID || empty.UsedBytes != 0 || empty.QuotaBytes != 0 || empty.AttachmentCount != 0 || empty.IndexedCount != 0 {
		t.Fatalf("unexpected empty usage: %+v", empty)
	}
	if empty.ByKind == nil || len(empty.ByKind) != 0 || empty.TopAttachments == nil || len(empty.TopAttachments) != 0 {
		t.Fatalf("expected non-nil empty slices: %+v", empty)
	}

	// Set a security policy first, then set storage quota — verify policy fields are NOT clobbered.
	wmEnabled := true
	wmText := "TOP SECRET"
	retDays := 90
	if _, err := als.UpdateWorkspaceSecurityPolicyGuarded(ctx, guard, ws1.ID, store.WorkspaceSecurityPolicyPatch{
		WatermarkEnabled: &wmEnabled,
		WatermarkText:    &wmText,
		RetentionDays:    &retDays,
	}); err != nil {
		t.Fatalf("UpdateWorkspaceSecurityPolicyGuarded: %v", err)
	}
	if err := sqs.SetWorkspaceStorageQuota(ctx, ws1.ID, 50<<20, owner.ID, now); err != nil {
		t.Fatalf("SetWorkspaceStorageQuota: %v", err)
	}
	pol, err := als.GetWorkspaceSecurityPolicy(ctx, owner.ID, ws1.ID)
	if err != nil {
		t.Fatalf("GetWorkspaceSecurityPolicy after quota update: %v", err)
	}
	if !pol.WatermarkEnabled || pol.WatermarkText != "TOP SECRET" || pol.RetentionDays != 90 {
		t.Fatalf("security policy clobbered after SetWorkspaceStorageQuota: %+v", pol)
	}

	// Update security policy again and confirm storage quota survives intact.
	wmText2 := "INTERNAL ONLY"
	if _, err := als.UpdateWorkspaceSecurityPolicyGuarded(ctx, guard, ws1.ID, store.WorkspaceSecurityPolicyPatch{
		WatermarkText: &wmText2,
	}); err != nil {
		t.Fatalf("UpdateWorkspaceSecurityPolicyGuarded 2: %v", err)
	}
	used, quota, err := sqs.GetWorkspaceStorageQuota(ctx, ws1.ID)
	if err != nil || used != 0 || quota != 50<<20 {
		t.Fatalf("GetWorkspaceStorageQuota = (%d, %d, %v), want (0, %d, nil)", used, quota, err, 50<<20)
	}

	// Create documents, drive files, and slides images across ws1 and ws2.
	doc1, err := st.CreateDoc(ctx, ws1.ID, owner.ID, nil, "Architecture Spec", nil)
	if err != nil {
		t.Fatalf("CreateDoc ws1: %v", err)
	}
	doc2, err := st.CreateDoc(ctx, ws2.ID, otherUser.ID, nil, "Other WS Doc", nil)
	if err != nil {
		t.Fatalf("CreateDoc ws2: %v", err)
	}

	// 11 attachments on doc1 (to test top-10 cap) + 1 drive file in ws1 + 1 attachment in ws2.
	var expectedDocBytes int64
	var indexedIDs []int64
	for i := 1; i <= 11; i++ {
		sz := int64(i * 1000)
		expectedDocBytes += sz
		f, err := st.CreateFile(ctx, store.FileMeta{
			DocID:      doc1.ID,
			UploaderID: owner.ID,
			Name:       fmt.Sprintf("spec-%02d.pdf", i),
			Mime:       "application/pdf",
			Size:       sz,
			ObjectKey:  fmt.Sprintf("docs/%d/k%d", doc1.ID, i),
		})
		if err != nil {
			t.Fatalf("CreateFile %d: %v", i, err)
		}
		if i <= 3 {
			indexedIDs = append(indexedIDs, f.ID)
			if err := ats.UpsertAttachmentText(ctx, store.AttachmentTextEntry{
				AttachmentID:  f.ID,
				DocID:         doc1.ID,
				WorkspaceID:   ws1.ID,
				Filename:      f.Name,
				Mime:          f.Mime,
				ExtractedText: fmt.Sprintf("indexed content %d", i),
				Extractor:     "pdf",
			}); err != nil {
				t.Fatalf("UpsertAttachmentText %d: %v", i, err)
			}
		}
	}

	driveSize := int64(25000)
	driveEntry, err := st.CreateDriveFile(ctx, guard, ws1.ID, nil, store.FileMeta{
		Name:      "big-dataset.xlsx",
		Mime:      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		Size:      driveSize,
		ObjectKey: fmt.Sprintf("drive/%d/big", ws1.ID),
	}, false)
	if err != nil {
		t.Fatalf("CreateDriveFile: %v", err)
	}
	driveFile, err := st.GetDriveFile(ctx, owner.ID, driveEntry.ID)
	if err != nil {
		t.Fatalf("GetDriveFile: %v", err)
	}
	if err := ats.UpsertAttachmentText(ctx, store.AttachmentTextEntry{
		AttachmentID:  driveFile.ID,
		DocID:         driveEntry.ID,
		WorkspaceID:   ws1.ID,
		Filename:      driveFile.Name,
		Mime:          driveFile.Mime,
		ExtractedText: "quarterly revenue dataset",
		Extractor:     "xlsx",
	}); err != nil {
		t.Fatalf("UpsertAttachmentText drive: %v", err)
	}

	// Workspace 2 attachment must stay isolated from ws1 stats.
	ws2Att, err := st.CreateFile(ctx, store.FileMeta{
		DocID:      doc2.ID,
		UploaderID: otherUser.ID,
		Name:       "other.txt",
		Mime:       "text/plain",
		Size:       999999,
		ObjectKey:  fmt.Sprintf("docs/%d/other", doc2.ID),
	})
	if err != nil {
		t.Fatalf("CreateFile ws2: %v", err)
	}

	expectedTotal := expectedDocBytes + driveSize
	usage, err := sqs.GetWorkspaceStorageUsage(ctx, ws1.ID)
	if err != nil {
		t.Fatalf("GetWorkspaceStorageUsage ws1: %v", err)
	}
	if usage.UsedBytes != expectedTotal {
		t.Fatalf("UsedBytes = %d, want %d", usage.UsedBytes, expectedTotal)
	}
	if usage.QuotaBytes != 50<<20 {
		t.Fatalf("QuotaBytes = %d, want %d", usage.QuotaBytes, 50<<20)
	}
	if usage.AttachmentCount != 12 {
		t.Fatalf("AttachmentCount = %d, want 12", usage.AttachmentCount)
	}
	if usage.IndexedCount != 4 {
		t.Fatalf("IndexedCount = %d, want 4", usage.IndexedCount)
	}
	if len(usage.ByKind) != 2 {
		t.Fatalf("ByKind len = %d, want 2: %+v", len(usage.ByKind), usage.ByKind)
	}
	// doc has 66000 bytes > file 25000 bytes
	if usage.ByKind[0].Kind != "doc" || usage.ByKind[0].Count != 11 || usage.ByKind[0].Bytes != expectedDocBytes {
		t.Fatalf("ByKind[0] = %+v, want doc count=11 bytes=%d", usage.ByKind[0], expectedDocBytes)
	}
	if usage.ByKind[1].Kind != "file" || usage.ByKind[1].Count != 1 || usage.ByKind[1].Bytes != driveSize {
		t.Fatalf("ByKind[1] = %+v, want file count=1 bytes=%d", usage.ByKind[1], driveSize)
	}
	if len(usage.TopAttachments) != 10 {
		t.Fatalf("TopAttachments len = %d, want 10", len(usage.TopAttachments))
	}
	if usage.TopAttachments[0].Name != "big-dataset.xlsx" || usage.TopAttachments[0].Size != driveSize || usage.TopAttachments[0].DocKind != "file" {
		t.Fatalf("TopAttachments[0] = %+v, want big-dataset.xlsx", usage.TopAttachments[0])
	}
	if usage.TopAttachments[1].Name != "spec-11.pdf" || usage.TopAttachments[1].Size != 11000 || usage.TopAttachments[1].DocTitle != "Architecture Spec" {
		t.Fatalf("TopAttachments[1] = %+v, want spec-11.pdf", usage.TopAttachments[1])
	}
	if usage.TopAttachments[9].Name != "spec-03.pdf" || usage.TopAttachments[9].Size != 3000 {
		t.Fatalf("TopAttachments[9] = %+v, want spec-03.pdf", usage.TopAttachments[9])
	}

	// Fast quota query agrees with full usage query.
	used, quota, err = sqs.GetWorkspaceStorageQuota(ctx, ws1.ID)
	if err != nil || used != expectedTotal || quota != 50<<20 {
		t.Fatalf("GetWorkspaceStorageQuota = (%d, %d, %v), want (%d, %d, nil)", used, quota, err, expectedTotal, 50<<20)
	}

	// ListAttachmentsForReindex: scoped to ws1, global (wsID == 0), and limited.
	ws1Items, err := sqs.ListAttachmentsForReindex(ctx, ws1.ID, 100)
	if err != nil {
		t.Fatalf("ListAttachmentsForReindex ws1: %v", err)
	}
	if len(ws1Items) != 12 {
		t.Fatalf("ws1 reindex items = %d, want 12", len(ws1Items))
	}
	for _, item := range ws1Items {
		if item.WorkspaceID != ws1.ID || item.ObjectKey == "" {
			t.Fatalf("unexpected ws1 reindex item: %+v", item)
		}
	}

	allItems, err := sqs.ListAttachmentsForReindex(ctx, 0, 100)
	if err != nil {
		t.Fatalf("ListAttachmentsForReindex all: %v", err)
	}
	if len(allItems) != 13 {
		t.Fatalf("all reindex items = %d, want 13", len(allItems))
	}
	foundWS2 := false
	for _, item := range allItems {
		if item.AttachmentID == ws2Att.ID && item.WorkspaceID == ws2.ID {
			foundWS2 = true
		}
	}
	if !foundWS2 {
		t.Fatalf("global ListAttachmentsForReindex missing ws2 attachment %d", ws2Att.ID)
	}

	limited, err := sqs.ListAttachmentsForReindex(ctx, ws1.ID, 5)
	if err != nil || len(limited) != 5 {
		t.Fatalf("limited reindex items = %d err=%v, want 5", len(limited), err)
	}

	// Resetting quota to 0 means unlimited again.
	if err := sqs.SetWorkspaceStorageQuota(ctx, ws1.ID, 0, owner.ID, now.Add(time.Minute)); err != nil {
		t.Fatalf("reset quota to 0: %v", err)
	}
	_, quotaAfter, err := sqs.GetWorkspaceStorageQuota(ctx, ws1.ID)
	if err != nil || quotaAfter != 0 {
		t.Fatalf("quotaAfter = %d err=%v, want 0", quotaAfter, err)
	}

	// Deleting an indexed attachment updates both UsedBytes and IndexedCount.
	if _, _, err := st.DeleteFile(ctx, indexedIDs[0]); err != nil {
		t.Fatalf("DeleteFile: %v", err)
	}
	if deleter, ok := st.(interface {
		DeleteAttachmentText(context.Context, int64) error
	}); ok {
		_ = deleter.DeleteAttachmentText(ctx, indexedIDs[0])
	}
	afterDel, err := sqs.GetWorkspaceStorageUsage(ctx, ws1.ID)
	if err != nil {
		t.Fatalf("GetWorkspaceStorageUsage after delete: %v", err)
	}
	if afterDel.AttachmentCount != 11 || afterDel.IndexedCount != 3 || afterDel.UsedBytes != expectedTotal-1000 {
		t.Fatalf("unexpected usage after delete: %+v", afterDel)
	}

	// Cancelled context returns context.Canceled.
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := sqs.GetWorkspaceStorageUsage(cctx, ws1.ID); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled GetWorkspaceStorageUsage = %v", err)
	}
	if _, _, err := sqs.GetWorkspaceStorageQuota(cctx, ws1.ID); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled GetWorkspaceStorageQuota = %v", err)
	}
	if err := sqs.SetWorkspaceStorageQuota(cctx, ws1.ID, 100, owner.ID, now); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled SetWorkspaceStorageQuota = %v", err)
	}
	if _, err := sqs.ListAttachmentsForReindex(cctx, ws1.ID, 10); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled ListAttachmentsForReindex = %v", err)
	}
}

func TestStorageQuotaStoreMemory(t *testing.T) {
	mem := store.NewMemory()
	exerciseStorageQuotaStore(t, mem, mem, mem, mem)
}

func TestStorageQuotaStorePostgres(t *testing.T) {
	dsn := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	schema := fmt.Sprintf("test_storage_quota_%d", time.Now().UnixNano())
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(ctx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE")

	cfg, err := pgxpool.ParseConfig(dsn)
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
	pg := &store.Postgres{Pool: pool}
	exerciseStorageQuotaStore(t, pg, pg, pg, pg)
}
