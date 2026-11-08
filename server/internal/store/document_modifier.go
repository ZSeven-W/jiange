package store

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// The actor is assigned by the authenticated sync connection, never by the
// operation payload. A missing actor means attribution is unknown.
type documentActorKey struct{}

func WithDocumentActor(ctx context.Context, userID int64) context.Context {
	return context.WithValue(ctx, documentActorKey{}, userID)
}

func documentActor(ctx context.Context) int64 {
	id, _ := ctx.Value(documentActorKey{}).(int64)
	return id
}

// Caller holds the memory-store lock. Unknown writers clear stale attribution.
func (m *Memory) setDocumentModifierLocked(doc *memDoc, userID int64) {
	doc.lastModifierID, doc.lastModifier = 0, ""
	if doc.meta.Kind == "doc" && userID > 0 && userID <= int64(len(m.users)) && m.users[userID-1].ID == userID {
		doc.lastModifierID, doc.lastModifier = userID, m.users[userID-1].Name
	}
}

// Called within the content transaction after nodes.updated_at is updated.
// The revision fence rejects this attribution after any untracked node update.
func recordDocumentModifier(ctx context.Context, tx pgx.Tx, docID, userID int64) error {
	if userID <= 0 {
		return nil
	}
	_, err := tx.Exec(ctx, `INSERT INTO document_last_modifier(doc_id,user_id,modification_revision)
		SELECT id,$2,modification_revision FROM nodes WHERE id=$1 AND kind='doc'
		ON CONFLICT (doc_id) DO UPDATE SET user_id=EXCLUDED.user_id, modification_revision=EXCLUDED.modification_revision`, docID, userID)
	return err
}
