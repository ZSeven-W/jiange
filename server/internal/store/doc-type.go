package store

import "context"

// DocTypeBoard marks a document created as a whiteboard (画板).
const DocTypeBoard = "board"

// ValidDocType reports whether t is an allowed document subtype.
func ValidDocType(t string) bool { return t == "" || t == DocTypeBoard }

// DocTypeStore sets or creates documents with a validated document subtype.
// SetCreatedDocType only allows the creator to set it once on kind='doc';
// CreateDocWithType and CreateDriveNodeWithType publish the subtype atomically
// inside the creation transaction.
type DocTypeStore interface {
	SetCreatedDocType(ctx context.Context, docID, creatorID int64, docType string) error
	CreateDocWithType(ctx context.Context, ws, creator int64, parent *int64, title, docType string, initial []RawOp) (DocMeta, error)
	CreateDriveNodeWithType(ctx context.Context, g RestoreGuard, ws int64, parent *int64, kind, docType, title string, personal bool) (DriveEntry, error)
}

func (p *Postgres) SetCreatedDocType(ctx context.Context, docID, creatorID int64, docType string) error {
	if !ValidDocType(docType) || docType == "" {
		return ErrConflict
	}
	tag, err := p.Pool.Exec(ctx, `UPDATE nodes SET doc_type=$3 WHERE id=$1 AND creator_id=$2 AND kind='doc' AND doc_type='' AND deleted_at IS NULL`, docID, creatorID, docType)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrNotFound
	}
	return nil
}

func (m *Memory) SetCreatedDocType(_ context.Context, docID, creatorID int64, docType string) error {
	if !ValidDocType(docType) || docType == "" {
		return ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.doc(docID)
	if d == nil || d.meta.CreatorID != creatorID || d.meta.Kind != "doc" || d.meta.DocType != "" {
		return ErrNotFound
	}
	d.meta.DocType = docType
	return nil
}
