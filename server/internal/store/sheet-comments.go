package store

import (
	"context"
	"errors"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// SheetComment is a cell-anchored comment bound to durable row/column IDs.
type SheetComment struct {
	ID          int64      `json:"id"`
	NodeID      int64      `json:"nodeId"`
	WorksheetID int64      `json:"worksheetId"`
	RowID       int64      `json:"rowId"`
	ColumnID    int64      `json:"columnId"`
	AuthorID    int64      `json:"authorId"`
	AuthorName  string     `json:"authorName"`
	Body        string     `json:"body"`
	Resolved    bool       `json:"resolved"`
	ResolvedBy  *int64     `json:"resolvedBy,omitempty"`
	ResolvedAt  *time.Time `json:"resolvedAt,omitempty"`
	CreatedAt   time.Time  `json:"createdAt"`
	UpdatedAt   time.Time  `json:"updatedAt"`
}

// SheetCommentStore persists cell-anchored spreadsheet comments with PG/Memory parity.
type SheetCommentStore interface {
	ListSheetComments(ctx context.Context, guard RestoreGuard, nodeID int64, worksheetID *int64) ([]SheetComment, error)
	CreateSheetComment(ctx context.Context, guard RestoreGuard, nodeID, worksheetID, rowID, columnID int64, body string) (SheetComment, error)
	UpdateSheetComment(ctx context.Context, guard RestoreGuard, nodeID, commentID int64, body *string, resolved *bool) (SheetComment, error)
	DeleteSheetComment(ctx context.Context, guard RestoreGuard, nodeID, commentID int64) error
}

func cleanSheetCommentBody(raw string) (string, bool) {
	b := strings.TrimSpace(raw)
	n := utf8.RuneCountInString(b)
	if n == 0 || n > 2000 || !utf8.ValidString(b) {
		return "", false
	}
	return b, true
}

func (m *Memory) ListSheetComments(ctx context.Context, g RestoreGuard, nodeID int64, worksheetID *int64) ([]SheetComment, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, _, _, _, err := m.authorizeSheetLocked(ctx, g, nodeID, RoleView); err != nil {
		return nil, err
	}
	out := make([]SheetComment, 0)
	for _, c := range m.sheetComments {
		if c.NodeID != nodeID {
			continue
		}
		if worksheetID != nil && c.WorksheetID != *worksheetID {
			continue
		}
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].ID < out[j].ID
		}
		return out[i].CreatedAt.Before(out[j].CreatedAt)
	})
	return out, nil
}

func (m *Memory) CreateSheetComment(ctx context.Context, g RestoreGuard, nodeID, worksheetID, rowID, columnID int64, body string) (SheetComment, error) {
	clean, ok := cleanSheetCommentBody(body)
	if !ok {
		return SheetComment{}, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	doc, book, role, expires, err := m.authorizeSheetLocked(ctx, g, nodeID, RoleView)
	if err != nil {
		return SheetComment{}, err
	}
	if !DocumentCommentAllowed(doc.meta, role) {
		return SheetComment{}, ErrForbidden
	}
	ws := book.sheets[worksheetID]
	if ws == nil {
		return SheetComment{}, ErrNotFound
	}
	if !ws.rowIndex[rowID] || !ws.colIndex[columnID] {
		return SheetComment{}, ErrNotFound
	}
	if err := driveMemoryEnd(ctx, g, expires); err != nil {
		return SheetComment{}, err
	}
	m.sheetCommentSeq++
	now := time.Now()
	authorName := ""
	if g.UserID >= 1 && g.UserID <= int64(len(m.users)) {
		authorName = m.users[g.UserID-1].Name
	}
	cm := SheetComment{
		ID:          m.sheetCommentSeq,
		NodeID:      nodeID,
		WorksheetID: worksheetID,
		RowID:       rowID,
		ColumnID:    columnID,
		AuthorID:    g.UserID,
		AuthorName:  authorName,
		Body:        clean,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	m.sheetComments = append(m.sheetComments, cm)
	return cm, nil
}

func (m *Memory) UpdateSheetComment(ctx context.Context, g RestoreGuard, nodeID, commentID int64, body *string, resolved *bool) (SheetComment, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	doc, _, role, expires, err := m.authorizeSheetLocked(ctx, g, nodeID, RoleView)
	if err != nil {
		return SheetComment{}, err
	}
	idx := -1
	for i := range m.sheetComments {
		if m.sheetComments[i].ID == commentID && m.sheetComments[i].NodeID == nodeID {
			idx = i
			break
		}
	}
	if idx < 0 {
		return SheetComment{}, ErrNotFound
	}
	cm := m.sheetComments[idx]
	if body != nil {
		if cm.AuthorID != g.UserID {
			return SheetComment{}, ErrForbidden
		}
		clean, ok := cleanSheetCommentBody(*body)
		if !ok {
			return SheetComment{}, ErrConflict
		}
		cm.Body = clean
	}
	if resolved != nil {
		if !DocumentCommentAllowed(doc.meta, role) && cm.AuthorID != g.UserID && role != RoleManage {
			return SheetComment{}, ErrForbidden
		}
		cm.Resolved = *resolved
		if *resolved {
			uid := g.UserID
			now := time.Now()
			cm.ResolvedBy = &uid
			cm.ResolvedAt = &now
		} else {
			cm.ResolvedBy = nil
			cm.ResolvedAt = nil
		}
	}
	if err := driveMemoryEnd(ctx, g, expires); err != nil {
		return SheetComment{}, err
	}
	cm.UpdatedAt = time.Now()
	m.sheetComments[idx] = cm
	return cm, nil
}

func (m *Memory) DeleteSheetComment(ctx context.Context, g RestoreGuard, nodeID, commentID int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, _, role, expires, err := m.authorizeSheetLocked(ctx, g, nodeID, RoleView)
	if err != nil {
		return err
	}
	idx := -1
	for i := range m.sheetComments {
		if m.sheetComments[i].ID == commentID && m.sheetComments[i].NodeID == nodeID {
			idx = i
			break
		}
	}
	if idx < 0 {
		return ErrNotFound
	}
	if m.sheetComments[idx].AuthorID != g.UserID && role != RoleManage {
		return ErrForbidden
	}
	if err := driveMemoryEnd(ctx, g, expires); err != nil {
		return err
	}
	m.sheetComments = append(m.sheetComments[:idx], m.sheetComments[idx+1:]...)
	return nil
}

func (p *Postgres) ListSheetComments(ctx context.Context, g RestoreGuard, nodeID int64, worksheetID *int64) (out []SheetComment, err error) {
	out = []SheetComment{}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expires, e := lockSheetPG(ctx, tx, g, nodeID, RoleView, false)
		if e != nil {
			return e
		}
		var rows pgx.Rows
		if worksheetID != nil {
			rows, e = tx.Query(ctx, `
				SELECT c.id, c.node_id, c.worksheet_id, c.row_id, c.column_id, c.author_id,
				       COALESCE((SELECT u.name FROM users u WHERE u.id = c.author_id), ''),
				       c.body, c.resolved, c.resolved_by, c.resolved_at, c.created_at, c.updated_at
				FROM sheet_comments c
				WHERE c.node_id = $1 AND c.worksheet_id = $2
				ORDER BY c.created_at ASC, c.id ASC
			`, nodeID, *worksheetID)
		} else {
			rows, e = tx.Query(ctx, `
				SELECT c.id, c.node_id, c.worksheet_id, c.row_id, c.column_id, c.author_id,
				       COALESCE((SELECT u.name FROM users u WHERE u.id = c.author_id), ''),
				       c.body, c.resolved, c.resolved_by, c.resolved_at, c.created_at, c.updated_at
				FROM sheet_comments c
				WHERE c.node_id = $1
				ORDER BY c.created_at ASC, c.id ASC
			`, nodeID)
		}
		if e != nil {
			return e
		}
		for rows.Next() {
			var cm SheetComment
			if e = rows.Scan(&cm.ID, &cm.NodeID, &cm.WorksheetID, &cm.RowID, &cm.ColumnID, &cm.AuthorID, &cm.AuthorName, &cm.Body, &cm.Resolved, &cm.ResolvedBy, &cm.ResolvedAt, &cm.CreatedAt, &cm.UpdatedAt); e != nil {
				rows.Close()
				return e
			}
			out = append(out, cm)
		}
		if e = rows.Err(); e != nil {
			rows.Close()
			return e
		}
		rows.Close()
		return drivePGEnd(ctx, g, expires)
	})
	return out, drivePGError(err)
}

func (p *Postgres) CreateSheetComment(ctx context.Context, g RestoreGuard, nodeID, worksheetID, rowID, columnID int64, body string) (out SheetComment, err error) {
	clean, ok := cleanSheetCommentBody(body)
	if !ok {
		return out, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		info, expires, e := lockSheetPG(ctx, tx, g, nodeID, RoleView, false)
		if e != nil {
			return e
		}
		var commentMinRole string
		if e = tx.QueryRow(ctx, `SELECT comment_min_role FROM nodes WHERE id=$1`, nodeID).Scan(&commentMinRole); e != nil {
			return notFound(e)
		}
		if !DocumentCommentAllowed(DocMeta{Kind: "sheet", CommentMinRole: commentMinRole}, info.role) {
			return ErrForbidden
		}
		var wsMatch int
		if e = tx.QueryRow(ctx, `SELECT 1 FROM sheet_worksheets WHERE id=$1 AND node_id=$2`, worksheetID, nodeID).Scan(&wsMatch); e != nil {
			return notFound(e)
		}
		var rowMatch, colMatch int
		if e = tx.QueryRow(ctx, `SELECT 1 FROM sheet_rows WHERE worksheet_id=$1 AND id=$2`, worksheetID, rowID).Scan(&rowMatch); e != nil {
			return notFound(e)
		}
		if e = tx.QueryRow(ctx, `SELECT 1 FROM sheet_columns WHERE worksheet_id=$1 AND id=$2`, worksheetID, columnID).Scan(&colMatch); e != nil {
			return notFound(e)
		}
		e = tx.QueryRow(ctx, `
			INSERT INTO sheet_comments (node_id, worksheet_id, row_id, column_id, author_id, body)
			VALUES ($1, $2, $3, $4, $5, $6)
			RETURNING id, node_id, worksheet_id, row_id, column_id, author_id,
			          COALESCE((SELECT u.name FROM users u WHERE u.id = sheet_comments.author_id), ''),
			          body, resolved, resolved_by, resolved_at, created_at, updated_at
		`, nodeID, worksheetID, rowID, columnID, g.UserID, clean).Scan(
			&out.ID, &out.NodeID, &out.WorksheetID, &out.RowID, &out.ColumnID, &out.AuthorID,
			&out.AuthorName, &out.Body, &out.Resolved, &out.ResolvedBy, &out.ResolvedAt, &out.CreatedAt, &out.UpdatedAt,
		)
		if e != nil {
			return e
		}
		return drivePGEnd(ctx, g, expires)
	})
	return out, drivePGError(err)
}

func (p *Postgres) UpdateSheetComment(ctx context.Context, g RestoreGuard, nodeID, commentID int64, body *string, resolved *bool) (out SheetComment, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		info, expires, e := lockSheetPG(ctx, tx, g, nodeID, RoleView, false)
		if e != nil {
			return e
		}
		var commentMinRole string
		if e = tx.QueryRow(ctx, `SELECT comment_min_role FROM nodes WHERE id=$1`, nodeID).Scan(&commentMinRole); e != nil {
			return notFound(e)
		}
		var cur SheetComment
		e = tx.QueryRow(ctx, `
			SELECT id, node_id, worksheet_id, row_id, column_id, author_id, body, resolved, resolved_by, resolved_at
			FROM sheet_comments WHERE id=$1 AND node_id=$2 FOR UPDATE
		`, commentID, nodeID).Scan(&cur.ID, &cur.NodeID, &cur.WorksheetID, &cur.RowID, &cur.ColumnID, &cur.AuthorID, &cur.Body, &cur.Resolved, &cur.ResolvedBy, &cur.ResolvedAt)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		nextBody := cur.Body
		if body != nil {
			if cur.AuthorID != g.UserID {
				return ErrForbidden
			}
			clean, ok := cleanSheetCommentBody(*body)
			if !ok {
				return ErrConflict
			}
			nextBody = clean
		}
		nextResolved := cur.Resolved
		nextResolvedBy := cur.ResolvedBy
		nextResolvedAt := cur.ResolvedAt
		if resolved != nil {
			if !DocumentCommentAllowed(DocMeta{Kind: "sheet", CommentMinRole: commentMinRole}, info.role) && cur.AuthorID != g.UserID && info.role != RoleManage {
				return ErrForbidden
			}
			nextResolved = *resolved
			if *resolved {
				uid := g.UserID
				now := time.Now()
				nextResolvedBy = &uid
				nextResolvedAt = &now
			} else {
				nextResolvedBy = nil
				nextResolvedAt = nil
			}
		}
		e = tx.QueryRow(ctx, `
			UPDATE sheet_comments
			SET body=$2, resolved=$3, resolved_by=$4, resolved_at=$5, updated_at=now()
			WHERE id=$1
			RETURNING id, node_id, worksheet_id, row_id, column_id, author_id,
			          COALESCE((SELECT u.name FROM users u WHERE u.id = sheet_comments.author_id), ''),
			          body, resolved, resolved_by, resolved_at, created_at, updated_at
		`, commentID, nextBody, nextResolved, nextResolvedBy, nextResolvedAt).Scan(
			&out.ID, &out.NodeID, &out.WorksheetID, &out.RowID, &out.ColumnID, &out.AuthorID,
			&out.AuthorName, &out.Body, &out.Resolved, &out.ResolvedBy, &out.ResolvedAt, &out.CreatedAt, &out.UpdatedAt,
		)
		if e != nil {
			return e
		}
		return drivePGEnd(ctx, g, expires)
	})
	return out, drivePGError(err)
}

func (p *Postgres) DeleteSheetComment(ctx context.Context, g RestoreGuard, nodeID, commentID int64) error {
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		info, expires, e := lockSheetPG(ctx, tx, g, nodeID, RoleView, false)
		if e != nil {
			return e
		}
		var authorID int64
		e = tx.QueryRow(ctx, `SELECT author_id FROM sheet_comments WHERE id=$1 AND node_id=$2 FOR UPDATE`, commentID, nodeID).Scan(&authorID)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		if authorID != g.UserID && info.role != RoleManage {
			return ErrForbidden
		}
		if _, e = tx.Exec(ctx, `DELETE FROM sheet_comments WHERE id=$1 AND node_id=$2`, commentID, nodeID); e != nil {
			return e
		}
		return drivePGEnd(ctx, g, expires)
	})
	return drivePGError(err)
}
