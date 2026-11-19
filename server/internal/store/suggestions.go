package store

import (
	"context"
	"errors"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

// DocSuggestion represents one revision/suggestion entry proposed on a document block.
type DocSuggestion struct {
	ID             int64      `json:"id"`
	DocID          int64      `json:"docId"`
	BlockID        string     `json:"blockId"`
	AuthorID       int64      `json:"authorId"`
	AuthorName     string     `json:"authorName"`
	Kind           string     `json:"kind"` // replace | insert | delete
	OriginalText   string     `json:"originalText"`
	ProposedText   string     `json:"proposedText"`
	Note           string     `json:"note"`
	Status         string     `json:"status"` // open | accepted | rejected | withdrawn
	ResolvedBy     *int64     `json:"resolvedBy,omitempty"`
	ResolvedByName string     `json:"resolvedByName,omitempty"`
	ResolvedAt     *time.Time `json:"resolvedAt,omitempty"`
	CreatedAt      time.Time  `json:"createdAt"`
	UpdatedAt      time.Time  `json:"updatedAt"`
}

// SuggestionStore persists document revision/suggestion entries.
type SuggestionStore interface {
	ListDocSuggestions(ctx context.Context, docID int64, status string) ([]DocSuggestion, error)
	CreateDocSuggestion(ctx context.Context, s DocSuggestion) (DocSuggestion, error)
	GetDocSuggestion(ctx context.Context, docID, suggestionID int64) (DocSuggestion, error)
	ResolveDocSuggestion(ctx context.Context, docID, suggestionID int64, status string, actorID int64) (DocSuggestion, error)
	ResolveAllDocSuggestions(ctx context.Context, docID int64, status string, actorID int64) ([]DocSuggestion, error)
	UpdateDocSuggestionNote(ctx context.Context, docID, suggestionID, authorID int64, note string) (DocSuggestion, error)
}

func (m *Memory) userNameLocked(uid int64) string {
	for _, u := range m.users {
		if u.ID == uid {
			return u.Name
		}
	}
	return ""
}

func (m *Memory) ListDocSuggestions(_ context.Context, docID int64, status string) ([]DocSuggestion, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]DocSuggestion, 0)
	for _, s := range m.suggestions {
		if s.DocID != docID {
			continue
		}
		if status == "open" && s.Status != "open" {
			continue
		}
		if status == "resolved" && s.Status == "open" {
			continue
		}
		cp := s
		cp.AuthorName = m.userNameLocked(cp.AuthorID)
		if cp.ResolvedBy != nil {
			cp.ResolvedByName = m.userNameLocked(*cp.ResolvedBy)
		}
		out = append(out, cp)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.After(out[j].CreatedAt)
		}
		return out[i].ID > out[j].ID
	})
	return out, nil
}

func (m *Memory) CreateDocSuggestion(_ context.Context, s DocSuggestion) (DocSuggestion, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	m.suggestionSeq++
	s.ID = m.suggestionSeq
	if s.Kind == "" {
		s.Kind = "replace"
	}
	s.Status = "open"
	s.CreatedAt = now
	s.UpdatedAt = now
	s.AuthorName = m.userNameLocked(s.AuthorID)
	m.suggestions = append(m.suggestions, s)
	return s, nil
}

func (m *Memory) GetDocSuggestion(_ context.Context, docID, suggestionID int64) (DocSuggestion, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range m.suggestions {
		if s.DocID == docID && s.ID == suggestionID {
			cp := s
			cp.AuthorName = m.userNameLocked(cp.AuthorID)
			if cp.ResolvedBy != nil {
				cp.ResolvedByName = m.userNameLocked(*cp.ResolvedBy)
			}
			return cp, nil
		}
	}
	return DocSuggestion{}, ErrNotFound
}

func (m *Memory) ResolveDocSuggestion(_ context.Context, docID, suggestionID int64, status string, actorID int64) (DocSuggestion, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.suggestions {
		if m.suggestions[i].DocID != docID || m.suggestions[i].ID != suggestionID {
			continue
		}
		if m.suggestions[i].Status != "open" {
			return DocSuggestion{}, ErrConflict
		}
		now := time.Now()
		actor := actorID
		m.suggestions[i].Status = status
		m.suggestions[i].ResolvedBy = &actor
		m.suggestions[i].ResolvedAt = &now
		m.suggestions[i].UpdatedAt = now
		cp := m.suggestions[i]
		cp.AuthorName = m.userNameLocked(cp.AuthorID)
		cp.ResolvedByName = m.userNameLocked(actorID)
		return cp, nil
	}
	return DocSuggestion{}, ErrNotFound
}

func (m *Memory) ResolveAllDocSuggestions(_ context.Context, docID int64, status string, actorID int64) ([]DocSuggestion, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	actor := actorID
	out := make([]DocSuggestion, 0)
	for i := range m.suggestions {
		if m.suggestions[i].DocID != docID || m.suggestions[i].Status != "open" {
			continue
		}
		m.suggestions[i].Status = status
		m.suggestions[i].ResolvedBy = &actor
		m.suggestions[i].ResolvedAt = &now
		m.suggestions[i].UpdatedAt = now
		cp := m.suggestions[i]
		cp.AuthorName = m.userNameLocked(cp.AuthorID)
		cp.ResolvedByName = m.userNameLocked(actorID)
		out = append(out, cp)
	}
	return out, nil
}

func (m *Memory) UpdateDocSuggestionNote(_ context.Context, docID, suggestionID, authorID int64, note string) (DocSuggestion, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.suggestions {
		if m.suggestions[i].DocID != docID || m.suggestions[i].ID != suggestionID {
			continue
		}
		if m.suggestions[i].AuthorID != authorID {
			return DocSuggestion{}, ErrForbidden
		}
		if m.suggestions[i].Status != "open" {
			return DocSuggestion{}, ErrConflict
		}
		m.suggestions[i].Note = note
		m.suggestions[i].UpdatedAt = time.Now()
		cp := m.suggestions[i]
		cp.AuthorName = m.userNameLocked(cp.AuthorID)
		return cp, nil
	}
	return DocSuggestion{}, ErrNotFound
}

func scanSuggestion(row pgx.Row) (DocSuggestion, error) {
	var s DocSuggestion
	err := row.Scan(
		&s.ID, &s.DocID, &s.BlockID, &s.AuthorID, &s.AuthorName,
		&s.Kind, &s.OriginalText, &s.ProposedText, &s.Note, &s.Status,
		&s.ResolvedBy, &s.ResolvedByName, &s.ResolvedAt, &s.CreatedAt, &s.UpdatedAt,
	)
	return s, err
}

const suggestionSelectCols = `
	s.id, s.doc_id, s.block_id, s.author_id, COALESCE(au.name, ''),
	s.kind, s.original_text, s.proposed_text, s.note, s.status,
	s.resolved_by, COALESCE(ru.name, ''), s.resolved_at, s.created_at, s.updated_at
`

func (p *Postgres) ListDocSuggestions(ctx context.Context, docID int64, status string) ([]DocSuggestion, error) {
	where := "s.doc_id = $1"
	switch status {
	case "open":
		where += " AND s.status = 'open'"
	case "resolved":
		where += " AND s.status <> 'open'"
	}
	rows, err := p.Pool.Query(ctx, `
		SELECT `+suggestionSelectCols+`
		FROM doc_suggestions s
		LEFT JOIN users au ON au.id = s.author_id
		LEFT JOIN users ru ON ru.id = s.resolved_by
		WHERE `+where+`
		ORDER BY s.created_at DESC, s.id DESC
	`, docID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]DocSuggestion, 0)
	for rows.Next() {
		s, err := scanSuggestion(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (p *Postgres) CreateDocSuggestion(ctx context.Context, s DocSuggestion) (DocSuggestion, error) {
	if s.Kind == "" {
		s.Kind = "replace"
	}
	row := p.Pool.QueryRow(ctx, `
		WITH ins AS (
			INSERT INTO doc_suggestions (doc_id, block_id, author_id, kind, original_text, proposed_text, note)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			RETURNING *
		)
		SELECT `+suggestionSelectCols+`
		FROM ins s
		LEFT JOIN users au ON au.id = s.author_id
		LEFT JOIN users ru ON ru.id = s.resolved_by
	`, s.DocID, s.BlockID, s.AuthorID, s.Kind, s.OriginalText, s.ProposedText, s.Note)
	return scanSuggestion(row)
}

func (p *Postgres) GetDocSuggestion(ctx context.Context, docID, suggestionID int64) (DocSuggestion, error) {
	row := p.Pool.QueryRow(ctx, `
		SELECT `+suggestionSelectCols+`
		FROM doc_suggestions s
		LEFT JOIN users au ON au.id = s.author_id
		LEFT JOIN users ru ON ru.id = s.resolved_by
		WHERE s.doc_id = $1 AND s.id = $2
	`, docID, suggestionID)
	s, err := scanSuggestion(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return DocSuggestion{}, ErrNotFound
	}
	return s, err
}

func (p *Postgres) ResolveDocSuggestion(ctx context.Context, docID, suggestionID int64, status string, actorID int64) (DocSuggestion, error) {
	row := p.Pool.QueryRow(ctx, `
		WITH upd AS (
			UPDATE doc_suggestions
			SET status = $3, resolved_by = $4, resolved_at = now(), updated_at = now()
			WHERE doc_id = $1 AND id = $2 AND status = 'open'
			RETURNING *
		)
		SELECT `+suggestionSelectCols+`
		FROM upd s
		LEFT JOIN users au ON au.id = s.author_id
		LEFT JOIN users ru ON ru.id = s.resolved_by
	`, docID, suggestionID, status, actorID)
	s, err := scanSuggestion(row)
	if errors.Is(err, pgx.ErrNoRows) {
		if _, gerr := p.GetDocSuggestion(ctx, docID, suggestionID); gerr == nil {
			return DocSuggestion{}, ErrConflict
		}
		return DocSuggestion{}, ErrNotFound
	}
	return s, err
}

func (p *Postgres) ResolveAllDocSuggestions(ctx context.Context, docID int64, status string, actorID int64) ([]DocSuggestion, error) {
	rows, err := p.Pool.Query(ctx, `
		WITH upd AS (
			UPDATE doc_suggestions
			SET status = $2, resolved_by = $3, resolved_at = now(), updated_at = now()
			WHERE doc_id = $1 AND status = 'open'
			RETURNING *
		)
		SELECT `+suggestionSelectCols+`
		FROM upd s
		LEFT JOIN users au ON au.id = s.author_id
		LEFT JOIN users ru ON ru.id = s.resolved_by
		ORDER BY s.created_at ASC, s.id ASC
	`, docID, status, actorID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]DocSuggestion, 0)
	for rows.Next() {
		s, err := scanSuggestion(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (p *Postgres) UpdateDocSuggestionNote(ctx context.Context, docID, suggestionID, authorID int64, note string) (DocSuggestion, error) {
	existing, err := p.GetDocSuggestion(ctx, docID, suggestionID)
	if err != nil {
		return DocSuggestion{}, err
	}
	if existing.AuthorID != authorID {
		return DocSuggestion{}, ErrForbidden
	}
	if existing.Status != "open" {
		return DocSuggestion{}, ErrConflict
	}
	row := p.Pool.QueryRow(ctx, `
		WITH upd AS (
			UPDATE doc_suggestions
			SET note = $3, updated_at = now()
			WHERE doc_id = $1 AND id = $2 AND author_id = $4 AND status = 'open'
			RETURNING *
		)
		SELECT `+suggestionSelectCols+`
		FROM upd s
		LEFT JOIN users au ON au.id = s.author_id
		LEFT JOIN users ru ON ru.id = s.resolved_by
	`, docID, suggestionID, note, authorID)
	s, err := scanSuggestion(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return DocSuggestion{}, ErrConflict
	}
	return s, err
}
