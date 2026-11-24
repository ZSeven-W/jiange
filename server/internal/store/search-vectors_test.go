package store

import (
	"context"
	"errors"
	"testing"
)

func TestEmbeddingStoreMemory(t *testing.T) {
	ctx := context.Background()
	memA := NewMemory()
	memB := NewMemory()

	// Empty lookup returns empty non-nil map.
	got, err := memA.GetDocEmbeddings(ctx, nil)
	if err != nil || got == nil || len(got) != 0 {
		t.Fatalf("empty lookup: got=%v err=%v", got, err)
	}

	// Reject invalid doc ID.
	if err := memA.UpsertDocEmbedding(ctx, DocEmbedding{DocID: 0}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("invalid docID expected ErrInvalidInput, got %v", err)
	}

	vec1 := []float32{0.6, 0.8, 0.0}
	if err := memA.UpsertDocEmbedding(ctx, DocEmbedding{
		DocID:       10,
		WorkspaceID: 2,
		ContentHash: "hash-v1",
		Vector:      vec1,
		Excerpt:     "initial\x00excerpt",
	}); err != nil {
		t.Fatalf("upsert v1: %v", err)
	}
	// Mutating caller slice must not corrupt stored vector.
	vec1[0] = -99

	got, err = memA.GetDocEmbeddings(ctx, []int64{10, 999})
	if err != nil {
		t.Fatalf("get embeddings: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("expected 1 embedding, got %d", len(got))
	}
	e10 := got[10]
	if e10.Model != "local-ngram-v1" || e10.Dimensions != 3 || e10.ContentHash != "hash-v1" || e10.Excerpt != "initialexcerpt" {
		t.Fatalf("unexpected stored embedding: %+v", e10)
	}
	if len(e10.Vector) != 3 || e10.Vector[0] != 0.6 || e10.Vector[1] != 0.8 {
		t.Fatalf("vector mutated or corrupted: %+v", e10.Vector)
	}
	if e10.UpdatedAt.IsZero() {
		t.Fatal("expected non-zero UpdatedAt")
	}

	// Mutating returned slice must not corrupt stored copy.
	e10.Vector[1] = 42
	gotAgain, err := memA.GetDocEmbeddings(ctx, []int64{10})
	if err != nil || gotAgain[10].Vector[1] != 0.8 {
		t.Fatalf("returned slice was not cloned: %+v err=%v", gotAgain[10].Vector, err)
	}

	// Overwrite existing embedding with a new model and hash.
	if err := memA.UpsertDocEmbedding(ctx, DocEmbedding{
		DocID:       10,
		WorkspaceID: 2,
		Model:       "text-embedding-3-small",
		ContentHash: "hash-v2",
		Dimensions:  2,
		Vector:      []float32{1, 0},
		Excerpt:     "updated excerpt",
	}); err != nil {
		t.Fatalf("upsert v2: %v", err)
	}
	gotV2, err := memA.GetDocEmbeddings(ctx, []int64{10})
	if err != nil || gotV2[10].ContentHash != "hash-v2" || gotV2[10].Model != "text-embedding-3-small" || gotV2[10].Dimensions != 2 {
		t.Fatalf("unexpected v2 embedding: %+v err=%v", gotV2[10], err)
	}

	// Independent Memory instances do not share vector state.
	gotB, err := memB.GetDocEmbeddings(ctx, []int64{10})
	if err != nil || len(gotB) != 0 {
		t.Fatalf("memB leaked memA embeddings: %+v err=%v", gotB, err)
	}

	// Cancelled context fails fast.
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := memA.GetDocEmbeddings(cctx, []int64{10}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled GetDocEmbeddings: got %v", err)
	}
	if err := memA.UpsertDocEmbedding(cctx, DocEmbedding{DocID: 11}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled UpsertDocEmbedding: got %v", err)
	}
}

func TestAttachmentTextStoreMemory(t *testing.T) {
	ctx := context.Background()
	mem := NewMemory()

	if err := mem.UpsertAttachmentText(ctx, AttachmentTextEntry{AttachmentID: 0, DocID: 1}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("invalid attachment ID expected ErrInvalidInput, got %v", err)
	}
	if err := mem.UpsertAttachmentText(ctx, AttachmentTextEntry{AttachmentID: 1, DocID: 0}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("invalid doc ID expected ErrInvalidInput, got %v", err)
	}

	entries := []AttachmentTextEntry{
		{
			AttachmentID:  102,
			DocID:         5,
			WorkspaceID:   1,
			Filename:      "Q4-Roadmap.pptx",
			Mime:          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
			ExtractedText: "Milestone: Launch Hybrid Vector Search 100% ready",
			Extractor:     "pptx",
		},
		{
			AttachmentID:  101,
			DocID:         5,
			WorkspaceID:   1,
			Filename:      "合同条款.docx",
			Mime:          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			ExtractedText: "甲方承诺在 30 天内完成私有化\x00部署验收。",
			Extractor:     "docx",
		},
		{
			AttachmentID:  201,
			DocID:         9,
			WorkspaceID:   1,
			Filename:      "secret-audit.pdf",
			Mime:          "application/pdf",
			ExtractedText: "Confidential SOC2 Type II audit report",
			Extractor:     "pdf",
		},
	}
	for _, e := range entries {
		if err := mem.UpsertAttachmentText(ctx, e); err != nil {
			t.Fatalf("upsert attachment %d: %v", e.AttachmentID, err)
		}
	}

	// ListAttachmentTextsByDocs returns entries sorted by AttachmentID ascending.
	listed, err := mem.ListAttachmentTextsByDocs(ctx, []int64{5, 9, 999})
	if err != nil {
		t.Fatalf("list attachments: %v", err)
	}
	if len(listed[5]) != 2 || listed[5][0].AttachmentID != 101 || listed[5][1].AttachmentID != 102 {
		t.Fatalf("unexpected doc 5 attachments: %+v", listed[5])
	}
	if listed[5][0].ExtractedText != "甲方承诺在 30 天内完成私有化部署验收。" {
		t.Fatalf("NUL byte not stripped: %q", listed[5][0].ExtractedText)
	}
	if len(listed[9]) != 1 || len(listed[999]) != 0 {
		t.Fatalf("unexpected doc 9 / 999 attachments: %+v", listed)
	}

	// Case-insensitive search & special SQL-like characters (%).
	hits, err := mem.SearchAttachmentDocIDs(ctx, []int64{5, 9}, "hybrid vector search 100%")
	if err != nil || !hits[5] || hits[9] {
		t.Fatalf("search hybrid vector: hits=%v err=%v", hits, err)
	}

	// CJK search scoped strictly to provided candidate docIDs.
	hits, err = mem.SearchAttachmentDocIDs(ctx, []int64{5}, "私有化部署验收")
	if err != nil || !hits[5] {
		t.Fatalf("search CJK: hits=%v err=%v", hits, err)
	}
	hits, err = mem.SearchAttachmentDocIDs(ctx, []int64{5}, "SOC2")
	if err != nil || len(hits) != 0 {
		t.Fatalf("search should respect candidate docID filter, got %v err=%v", hits, err)
	}

	// Filename match works too.
	hits, err = mem.SearchAttachmentDocIDs(ctx, []int64{5, 9}, "q4-roadmap")
	if err != nil || !hits[5] || hits[9] {
		t.Fatalf("filename search: hits=%v err=%v", hits, err)
	}

	// Update existing attachment entry replaces content.
	if err := mem.UpsertAttachmentText(ctx, AttachmentTextEntry{
		AttachmentID:  201,
		DocID:         9,
		WorkspaceID:   1,
		Filename:      "secret-audit.pdf",
		Mime:          "application/pdf",
		ExtractedText: "Updated ISO27001 compliance checklist",
		Extractor:     "pdf",
	}); err != nil {
		t.Fatalf("update attachment: %v", err)
	}
	hits, err = mem.SearchAttachmentDocIDs(ctx, []int64{9}, "SOC2")
	if err != nil || len(hits) != 0 {
		t.Fatalf("stale content should not match after update: %v err=%v", hits, err)
	}
	hits, err = mem.SearchAttachmentDocIDs(ctx, []int64{9}, "iso27001")
	if err != nil || !hits[9] {
		t.Fatalf("updated content should match: %v err=%v", hits, err)
	}

	// DeleteAttachmentText removes it.
	if err := mem.DeleteAttachmentText(ctx, 201); err != nil {
		t.Fatalf("delete attachment text: %v", err)
	}
	hits, err = mem.SearchAttachmentDocIDs(ctx, []int64{9}, "iso27001")
	if err != nil || len(hits) != 0 {
		t.Fatalf("deleted attachment should not match: %v err=%v", hits, err)
	}
}
