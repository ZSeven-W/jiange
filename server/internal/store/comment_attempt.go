package store

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
)

var commentMutationID = regexp.MustCompile(`^[0-9a-f]{32}$`)

type commentAttemptKey struct {
	doc, user int64
	id        string
}
type commentAttemptReceipt struct {
	digest    [32]byte
	commentID int64
}

// commentAttemptDigest hashes the canonical, normalized request. A nil mentions
// slice and an empty slice are semantically identical; mention order and every
// anchor field are otherwise significant. Version the encoding so it cannot be
// silently reinterpreted by a future implementation.
func commentAttemptDigest(c Comment) ([32]byte, error) {
	mentions := c.Mentions
	if mentions == nil {
		mentions = []int64{}
	}
	payload := struct {
		Version   int     `json:"version"`
		DocID     int64   `json:"docId"`
		UserID    int64   `json:"userId"`
		ParentID  *int64  `json:"parentId"`
		Block     string  `json:"block"`
		StartChar string  `json:"startChar"`
		EndChar   string  `json:"endChar"`
		Quote     string  `json:"quote"`
		Body      string  `json:"body"`
		Mentions  []int64 `json:"mentions"`
	}{1, c.DocID, c.UserID, c.ParentID, c.Block, c.StartChar, c.EndChar, c.Quote, c.Body, mentions}
	b, err := json.Marshal(payload)
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(b), nil
}

func attemptResult(id string, docID, userID, commentID int64, comment *Comment) CommentAttemptResult {
	state := "deleted"
	if comment != nil {
		state = "committed"
	}
	return CommentAttemptResult{MutationID: id, DocID: docID, UserID: userID, CommentID: commentID, State: state, Comment: comment}
}

func (m *Memory) AddCommentAttemptGuarded(ctx context.Context, guard RestoreGuard, mutationID string, c Comment) (CommentAttemptResult, error) {
	if c.UserID <= 0 || c.UserID != guard.UserID {
		return CommentAttemptResult{}, ErrCommentAttemptAccountChanged
	}
	if !commentMutationID.MatchString(mutationID) {
		return CommentAttemptResult{}, ErrConflict
	}
	digest, err := commentAttemptDigest(c)
	if err != nil {
		return CommentAttemptResult{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expiry, accessErr := m.checkCommentLocked(ctx, guard, c.DocID)
	if accessErr != nil && !errors.Is(accessErr, ErrCommentPermissionDenied) {
		return CommentAttemptResult{}, accessErr
	}
	key := commentAttemptKey{c.DocID, c.UserID, mutationID}
	if receipt, ok := m.sh.commentAttempts[key]; ok {
		if receipt.digest != digest {
			return CommentAttemptResult{}, ErrCommentAttemptMismatch
		}
		if err := ctx.Err(); err != nil {
			return CommentAttemptResult{}, err
		}
		if !guard.currentTime().Before(expiry) {
			return CommentAttemptResult{}, ErrUnauthenticated
		}
		for _, existing := range m.comments {
			if existing.ID == receipt.commentID && existing.DocID == c.DocID {
				copy := existing
				copy.Mentions = append([]int64(nil), existing.Mentions...)
				return attemptResult(mutationID, c.DocID, c.UserID, receipt.commentID, &copy), nil
			}
		}
		return attemptResult(mutationID, c.DocID, c.UserID, receipt.commentID, nil), nil
	}
	if accessErr != nil {
		return CommentAttemptResult{}, accessErr
	}
	var parentAuthor int64
	if c.ParentID != nil {
		found := false
		for _, parent := range m.comments {
			if parent.ID == *c.ParentID && parent.DocID == c.DocID {
				found, parentAuthor = true, parent.UserID
				break
			}
		}
		if !found {
			return CommentAttemptResult{}, ErrNotFound
		}
	}
	if err = ctx.Err(); err != nil {
		return CommentAttemptResult{}, err
	}
	if !guard.currentTime().Before(expiry) {
		return CommentAttemptResult{}, ErrUnauthenticated
	}
	c.ID = m.nextCommentIDLocked()
	if user := m.userByID(c.UserID); user != nil {
		c.UserName = user.Name
	}
	now := time.Now()
	c.CreatedAt, c.UpdatedAt = now, now
	c.Mentions = append([]int64(nil), c.Mentions...)
	items := m.commentNotificationsLocked(c, guard.UserID, parentAuthor, false)
	if err = ctx.Err(); err != nil {
		return CommentAttemptResult{}, err
	}
	if !guard.currentTime().Before(expiry) {
		return CommentAttemptResult{}, ErrUnauthenticated
	}
	if m.sh.commentAttempts == nil {
		m.sh.commentAttempts = make(map[commentAttemptKey]commentAttemptReceipt)
	}
	m.comments = append(m.comments, c)
	m.publishCommentNotificationsLocked(items, now)
	m.sh.commentAttempts[key] = commentAttemptReceipt{digest, c.ID}
	return attemptResult(mutationID, c.DocID, c.UserID, c.ID, &c), nil
}

func (p *Postgres) AddCommentAttemptGuarded(ctx context.Context, guard RestoreGuard, mutationID string, c Comment) (out CommentAttemptResult, err error) {
	if c.UserID <= 0 || c.UserID != guard.UserID {
		return out, ErrCommentAttemptAccountChanged
	}
	if !commentMutationID.MatchString(mutationID) {
		return out, ErrConflict
	}
	digest, err := commentAttemptDigest(c)
	if err != nil {
		return out, err
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expiry, accessErr := lockCommentAccess(ctx, tx, guard, c.DocID)
		if accessErr != nil && !errors.Is(accessErr, ErrCommentPermissionDenied) {
			return accessErr
		}
		var savedDigest []byte
		var savedID int64
		err := tx.QueryRow(ctx, `SELECT request_hash,comment_id FROM comment_attempt_receipts WHERE doc_id=$1 AND user_id=$2 AND mutation_id=$3`, c.DocID, c.UserID, mutationID).Scan(&savedDigest, &savedID)
		if err == nil {
			if !bytes.Equal(savedDigest, digest[:]) {
				return ErrCommentAttemptMismatch
			}
			existing, readErr := scanComment(tx.QueryRow(ctx, `SELECT `+commentCols+` FROM comments c LEFT JOIN users u ON u.id=c.user_id WHERE c.id=$1 AND c.doc_id=$2`, savedID, c.DocID))
			if readErr != nil && !errors.Is(readErr, ErrNotFound) {
				return readErr
			}
			if !guard.currentTime().Before(expiry) {
				return ErrUnauthenticated
			}
			if errors.Is(readErr, ErrNotFound) {
				out = attemptResult(mutationID, c.DocID, c.UserID, savedID, nil)
			} else {
				out = attemptResult(mutationID, c.DocID, c.UserID, savedID, &existing)
			}
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if accessErr != nil {
			return accessErr
		}
		var parentAuthor int64
		if c.ParentID != nil {
			err = tx.QueryRow(ctx, `SELECT user_id FROM comments WHERE id=$1 AND doc_id=$2 FOR SHARE`, *c.ParentID, c.DocID).Scan(&parentAuthor)
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			if err != nil {
				return err
			}
		}
		if c.Mentions == nil {
			c.Mentions = []int64{}
		}
		err = tx.QueryRow(ctx, `INSERT INTO comments (doc_id,user_id,parent_id,block,start_char,end_char,quote,body,mentions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,created_at,updated_at`, c.DocID, c.UserID, c.ParentID, c.Block, c.StartChar, c.EndChar, c.Quote, c.Body, c.Mentions).Scan(&c.ID, &c.CreatedAt, &c.UpdatedAt)
		if err != nil {
			return err
		}
		if err = tx.QueryRow(ctx, `SELECT name FROM users WHERE id=$1`, c.UserID).Scan(&c.UserName); err != nil {
			return err
		}
		if err = insertCommentNotificationsTx(ctx, tx, c, guard.UserID, parentAuthor, false); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO comment_attempt_receipts(doc_id,user_id,mutation_id,request_hash,comment_id) VALUES ($1,$2,$3,$4,$5)`, c.DocID, c.UserID, mutationID, digest[:], c.ID); err != nil {
			return err
		}
		if !guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		out = attemptResult(mutationID, c.DocID, c.UserID, c.ID, &c)
		return nil
	})
	if retryableRestoreConflict(err) {
		err = ErrConflict
	}
	if err != nil {
		out = CommentAttemptResult{}
	}
	return
}

// GetCommentAttemptGuarded only reports a caller's own receipt; absence is
// "unknown", never proof that an earlier request cannot still commit.
func (m *Memory) GetCommentAttemptGuarded(ctx context.Context, guard RestoreGuard, expectedUserID, docID int64, mutationID string) (CommentAttemptResult, error) {
	if expectedUserID <= 0 || expectedUserID != guard.UserID {
		return CommentAttemptResult{}, ErrCommentAttemptAccountChanged
	}
	if !commentMutationID.MatchString(mutationID) {
		return CommentAttemptResult{}, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expiry, accessErr := m.checkCommentLocked(ctx, guard, docID)
	if accessErr != nil && !errors.Is(accessErr, ErrCommentPermissionDenied) {
		return CommentAttemptResult{}, accessErr
	}
	if err := ctx.Err(); err != nil {
		return CommentAttemptResult{}, err
	}
	if !guard.currentTime().Before(expiry) {
		return CommentAttemptResult{}, ErrUnauthenticated
	}
	key := commentAttemptKey{docID, guard.UserID, mutationID}
	receipt, ok := m.sh.commentAttempts[key]
	if !ok {
		return CommentAttemptResult{MutationID: mutationID, DocID: docID, UserID: guard.UserID, State: "unknown"}, nil
	}
	for _, existing := range m.comments {
		if existing.ID == receipt.commentID && existing.DocID == docID {
			return CommentAttemptResult{MutationID: mutationID, DocID: docID, UserID: guard.UserID, CommentID: receipt.commentID, State: "committed"}, nil
		}
	}
	return attemptResult(mutationID, docID, guard.UserID, receipt.commentID, nil), nil
}

func (p *Postgres) GetCommentAttemptGuarded(ctx context.Context, guard RestoreGuard, expectedUserID, docID int64, mutationID string) (out CommentAttemptResult, err error) {
	if expectedUserID <= 0 || expectedUserID != guard.UserID {
		return out, ErrCommentAttemptAccountChanged
	}
	if !commentMutationID.MatchString(mutationID) {
		return out, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expiry, accessErr := lockCommentAccess(ctx, tx, guard, docID)
		if accessErr != nil && !errors.Is(accessErr, ErrCommentPermissionDenied) {
			return accessErr
		}
		var commentID int64
		var exists bool
		err := tx.QueryRow(ctx, `SELECT r.comment_id,EXISTS(SELECT 1 FROM comments c WHERE c.id=r.comment_id AND c.doc_id=r.doc_id)
			FROM comment_attempt_receipts r WHERE r.doc_id=$1 AND r.user_id=$2 AND r.mutation_id=$3`, docID, guard.UserID, mutationID).Scan(&commentID, &exists)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if !guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		out = CommentAttemptResult{MutationID: mutationID, DocID: docID, UserID: guard.UserID, CommentID: commentID, State: "unknown"}
		if err == nil {
			out.State = "deleted"
			if exists {
				out.State = "committed"
			}
		}
		return nil
	})
	if retryableRestoreConflict(err) {
		err = ErrConflict
	}
	if err != nil {
		out = CommentAttemptResult{}
	}
	return
}

// CommentAttemptCapabilityGuarded is also used before redacting a saved quote.
// Bind the claimed account before looking up document metadata, and read its
// current copy policy under the same session and document authorization locks.
func (m *Memory) CommentAttemptCapabilityGuarded(ctx context.Context, guard RestoreGuard, expectedUserID, docID int64) (bool, error) {
	if expectedUserID <= 0 || expectedUserID != guard.UserID {
		return false, ErrCommentAttemptAccountChanged
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	expiry, accessErr := m.checkCommentLocked(ctx, guard, docID)
	if accessErr != nil && !errors.Is(accessErr, ErrCommentPermissionDenied) {
		return false, accessErr
	}
	d := m.doc(docID)
	if d == nil {
		return false, ErrForbidden
	}
	allowed := DocumentCopyAllowed(d.meta, m.roleLocked(guard.UserID, d))
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if !guard.currentTime().Before(expiry) {
		return false, ErrUnauthenticated
	}
	return allowed, nil
}

func (p *Postgres) CommentAttemptCapabilityGuarded(ctx context.Context, guard RestoreGuard, expectedUserID, docID int64) (allowed bool, err error) {
	if expectedUserID <= 0 || expectedUserID != guard.UserID {
		return false, ErrCommentAttemptAccountChanged
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expiry, accessErr := lockCommentAccess(ctx, tx, guard, docID)
		if accessErr != nil && !errors.Is(accessErr, ErrCommentPermissionDenied) {
			return accessErr
		}
		role, protected, kind, err := lockCopySource(ctx, tx, docID, guard.UserID)
		if err != nil {
			return err
		}
		var copyMinRole string
		if err := tx.QueryRow(ctx, `SELECT copy_min_role FROM nodes WHERE id=$1`, docID).Scan(&copyMinRole); err != nil {
			return err
		}
		allowed = DocumentCopyAllowed(DocMeta{Kind: kind, CopyProtected: protected, CopyMinRole: copyMinRole}, role)
		if !guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		return nil
	})
	if retryableRestoreConflict(err) {
		err = ErrConflict
	}
	if err != nil {
		return false, err
	}
	return allowed, nil
}
