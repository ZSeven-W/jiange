package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/btquery"
	"github.com/jackc/pgx/v5"
)

// RecordCommentAttemptResult never contains comment text: a receipt may be
// returned after a row or a caller's access changed.
type RecordCommentAttemptResult struct {
	MutationID string `json:"mutationId"`
	BaseID     int64  `json:"baseId"`
	RecordID   int64  `json:"recordId"`
	UserID     int64  `json:"userId"`
	CommentID  int64  `json:"commentId"`
	State      string `json:"state"`
}

// RecordCommentAttemptStore is a distinct protocol: ordinary document
// comment receipts do not enforce record-level visibility.
type RecordCommentAttemptStore interface {
	RecordCommentAttemptCapability(context.Context, RestoreGuard, int64, int64) error
	AddRecordCommentAttempt(context.Context, RestoreGuard, int64, int64, string, Comment) (RecordCommentAttemptResult, error)
	GetRecordCommentAttempt(context.Context, RestoreGuard, int64, int64, string) (RecordCommentAttemptResult, error)
}

type recordCommentAttemptReceipt struct {
	recordID  int64
	digest    [32]byte
	commentID int64
}

func recordAttemptResult(baseID, recordID, userID int64, mutationID string, commentID int64, state string) RecordCommentAttemptResult {
	return RecordCommentAttemptResult{MutationID: mutationID, BaseID: baseID, RecordID: recordID, UserID: userID, CommentID: commentID, State: state}
}

func validateRecordAttempt(baseID, recordID int64, mutationID string, c Comment, guard RestoreGuard) error {
	if c.UserID <= 0 || c.UserID != guard.UserID {
		return ErrCommentAttemptAccountChanged
	}
	if baseID <= 0 || recordID <= 0 || c.DocID != baseID || c.Block != "record:"+strconv.FormatInt(recordID, 10) || c.StartChar != "" || c.EndChar != "" || c.Quote != "" || !commentMutationID.MatchString(mutationID) || !utf8.ValidString(c.Body) || utf8.RuneCountInString(c.Body) < 1 || utf8.RuneCountInString(c.Body) > 2000 || len(c.Mentions) > 20 || c.ParentID != nil && *c.ParentID <= 0 {
		return ErrConflict
	}
	return nil
}

// memoryRecordReaderLocked checks the recipient's current locked-view policy
// against the same row snapshot as the comment write; caller holds m.mu.
func (m *Memory) memoryRecordReaderLocked(ctx context.Context, uid, baseID int64, row Record) (bool, error) {
	policy, err := m.snapshotPolicyLocked(ctx, uid, baseID)
	if errors.Is(err, ErrNotFound) || errors.Is(err, ErrForbidden) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	for _, cfg := range policy.mandatory {
		if !btquery.Match(policy.specs, cfg, row.Cells) {
			return false, nil
		}
	}
	return true, nil
}

func (m *Memory) RecordCommentAttemptCapability(ctx context.Context, guard RestoreGuard, baseID, recordID int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, expires, err := m.checkBaseWriteLocked(guard, baseID)
	if err != nil {
		return err
	}
	i := m.recordIndexLocked(recordID)
	if i < 0 || m.b.records[i].BaseID != baseID {
		return ErrNotFound
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if !guard.currentTime().Before(expires) {
		return ErrUnauthenticated
	}
	return nil
}

func (m *Memory) AddRecordCommentAttempt(ctx context.Context, guard RestoreGuard, baseID, recordID int64, mutationID string, c Comment) (RecordCommentAttemptResult, error) {
	if err := validateRecordAttempt(baseID, recordID, mutationID, c, guard); err != nil {
		return RecordCommentAttemptResult{}, err
	}
	digest, err := commentAttemptDigest(c)
	if err != nil {
		return RecordCommentAttemptResult{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	_, expires, err := m.checkBaseWriteLocked(guard, baseID)
	if err != nil {
		return RecordCommentAttemptResult{}, err
	}
	key := commentAttemptKey{baseID, guard.UserID, mutationID}
	if receipt, ok := m.sh.recordCommentAttempts[key]; ok {
		if receipt.recordID != recordID || receipt.digest != digest {
			return RecordCommentAttemptResult{}, ErrCommentAttemptMismatch
		}
		if err := ctx.Err(); err != nil {
			return RecordCommentAttemptResult{}, err
		}
		if !guard.currentTime().Before(expires) {
			return RecordCommentAttemptResult{}, ErrUnauthenticated
		}
		state := "deleted"
		for _, existing := range m.comments {
			if existing.ID == receipt.commentID && existing.DocID == baseID {
				state = "committed"
				break
			}
		}
		return recordAttemptResult(baseID, recordID, guard.UserID, mutationID, receipt.commentID, state), nil
	}
	i := m.recordIndexLocked(recordID)
	if i < 0 || m.b.records[i].BaseID != baseID {
		return RecordCommentAttemptResult{}, ErrNotFound
	}
	row := m.b.records[i]
	var parentAuthor int64
	if c.ParentID != nil {
		found := false
		for _, parent := range m.comments {
			if parent.ID == *c.ParentID && parent.DocID == baseID && parent.Block == c.Block && parent.ParentID == nil {
				found = true
				parentAuthor = parent.UserID
				break
			}
		}
		if !found {
			return RecordCommentAttemptResult{}, ErrNotFound
		}
	}
	mentions := make([]int64, 0, len(c.Mentions))
	for _, uid := range c.Mentions {
		visible, e := m.memoryRecordReaderLocked(ctx, uid, baseID, row)
		if e != nil {
			return RecordCommentAttemptResult{}, e
		}
		if visible {
			mentions = append(mentions, uid)
		}
	}
	c.Mentions = mentions
	if parentAuthor > 0 {
		visible, e := m.memoryRecordReaderLocked(ctx, parentAuthor, baseID, row)
		if e != nil {
			return RecordCommentAttemptResult{}, e
		}
		if !visible {
			ctx = WithNotifySkip(ctx, []int64{parentAuthor})
		}
	}
	if err := ctx.Err(); err != nil {
		return RecordCommentAttemptResult{}, err
	}
	if !guard.currentTime().Before(expires) {
		return RecordCommentAttemptResult{}, ErrUnauthenticated
	}
	c.ID = m.nextCommentIDLocked()
	if user := m.userByID(c.UserID); user != nil {
		c.UserName = user.Name
	}
	now := time.Now()
	c.CreatedAt, c.UpdatedAt = now, now
	items := m.commentNotificationsLocked(ctx, c, guard.UserID, parentAuthor, false)
	if err := ctx.Err(); err != nil {
		return RecordCommentAttemptResult{}, err
	}
	if !guard.currentTime().Before(expires) {
		return RecordCommentAttemptResult{}, ErrUnauthenticated
	}
	if m.sh.recordCommentAttempts == nil {
		m.sh.recordCommentAttempts = make(map[commentAttemptKey]recordCommentAttemptReceipt)
	}
	m.comments = append(m.comments, c)
	m.publishCommentNotificationsLocked(items, now)
	m.sh.recordCommentAttempts[key] = recordCommentAttemptReceipt{recordID, digest, c.ID}
	return recordAttemptResult(baseID, recordID, guard.UserID, mutationID, c.ID, "committed"), nil
}

func (m *Memory) GetRecordCommentAttempt(ctx context.Context, guard RestoreGuard, baseID, recordID int64, mutationID string) (RecordCommentAttemptResult, error) {
	if baseID <= 0 || recordID <= 0 || !commentMutationID.MatchString(mutationID) {
		return RecordCommentAttemptResult{}, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	_, expires, err := m.checkBaseWriteLocked(guard, baseID)
	if err != nil {
		return RecordCommentAttemptResult{}, err
	}
	if err := ctx.Err(); err != nil {
		return RecordCommentAttemptResult{}, err
	}
	if !guard.currentTime().Before(expires) {
		return RecordCommentAttemptResult{}, ErrUnauthenticated
	}
	receipt, ok := m.sh.recordCommentAttempts[commentAttemptKey{baseID, guard.UserID, mutationID}]
	if !ok || receipt.recordID != recordID {
		return recordAttemptResult(baseID, recordID, guard.UserID, mutationID, 0, "unknown"), nil
	}
	state := "deleted"
	for _, c := range m.comments {
		if c.ID == receipt.commentID && c.DocID == baseID {
			state = "committed"
			break
		}
	}
	return recordAttemptResult(baseID, recordID, guard.UserID, mutationID, receipt.commentID, state), nil
}

// The Base node lock serializes guarded row/view writes. Table/row locks also
// fence older writers which do not yet take that node lock.
func lockRecordCommentBase(ctx context.Context, tx pgx.Tx, guard RestoreGuard, baseID, recordID int64, requireRow bool) (time.Time, Record, error) {
	_, expires, err := lockBaseWrite(ctx, tx, guard, baseID)
	if err != nil {
		return time.Time{}, Record{}, err
	}
	if _, err := tx.Exec(ctx, `LOCK TABLE base_fields, bt_views IN SHARE MODE`); err != nil {
		return time.Time{}, Record{}, err
	}
	row, err := scanRecord(tx.QueryRow(ctx, `SELECT `+recordCols+` FROM base_records WHERE base_id=$1 AND id=$2 FOR SHARE`, baseID, recordID))
	if errors.Is(err, ErrNotFound) && !requireRow {
		return expires, Record{}, nil
	}
	if err != nil {
		return time.Time{}, Record{}, err
	}
	return expires, row, nil
}

func pgRecordReadersLocked(ctx context.Context, tx pgx.Tx, baseID int64, row Record, candidates []int64) (map[int64]bool, error) {
	fields, err := pgFields(ctx, tx, baseID)
	if err != nil {
		return nil, err
	}
	views, err := pgViews(ctx, tx, baseID)
	if err != nil {
		return nil, err
	}
	specs := Specs(fields)
	var locked []btquery.Config
	for _, view := range views {
		var cfg btquery.Config
		if len(view.Config) > 0 && string(view.Config) != "null" && json.Unmarshal(view.Config, &cfg) != nil {
			return nil, ErrForbidden
		}
		if cfg.Locked {
			if err := btquery.ValidateLocked(specs, cfg); err != nil {
				return nil, err
			}
			locked = append(locked, cfg)
		}
	}
	ids := append([]int64(nil), candidates...)
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	out := make(map[int64]bool, len(ids))
	for _, uid := range ids {
		if uid <= 0 || out[uid] {
			continue
		}
		role, _, kind, err := lockCopySource(ctx, tx, baseID, uid)
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if kind != "base" || RoleRank(role) < RoleRank(RoleView) {
			continue
		}
		allowed := true
		if role != RoleManage {
			for _, cfg := range locked {
				if !btquery.Match(specs, cfg, row.Cells) {
					allowed = false
					break
				}
			}
		}
		if allowed {
			out[uid] = true
		}
	}
	return out, nil
}

func (p *Postgres) RecordCommentAttemptCapability(ctx context.Context, guard RestoreGuard, baseID, recordID int64) error {
	if baseID <= 0 || recordID <= 0 {
		return ErrConflict
	}
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, _, err := lockRecordCommentBase(ctx, tx, guard, baseID, recordID, true)
		if err != nil {
			return err
		}
		if !guard.currentTime().Before(expires) {
			return ErrUnauthenticated
		}
		return ctx.Err()
	})
	if retryableRestoreConflict(err) {
		return ErrConflict
	}
	return err
}

func (p *Postgres) AddRecordCommentAttempt(ctx context.Context, guard RestoreGuard, baseID, recordID int64, mutationID string, c Comment) (out RecordCommentAttemptResult, err error) {
	if err = validateRecordAttempt(baseID, recordID, mutationID, c, guard); err != nil {
		return out, err
	}
	digest, err := commentAttemptDigest(c)
	if err != nil {
		return out, err
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, row, err := lockRecordCommentBase(ctx, tx, guard, baseID, recordID, false)
		if err != nil {
			return err
		}
		var savedRecord, savedID int64
		var savedDigest []byte
		err = tx.QueryRow(ctx, `SELECT record_id, request_hash, comment_id FROM record_comment_attempt_receipts WHERE base_id=$1 AND user_id=$2 AND mutation_id=$3`, baseID, guard.UserID, mutationID).Scan(&savedRecord, &savedDigest, &savedID)
		if err == nil {
			if savedRecord != recordID || !bytes.Equal(savedDigest, digest[:]) {
				return ErrCommentAttemptMismatch
			}
			var exists bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM comments WHERE id=$1 AND doc_id=$2)`, savedID, baseID).Scan(&exists); err != nil {
				return err
			}
			if !guard.currentTime().Before(expires) {
				return ErrUnauthenticated
			}
			state := "deleted"
			if exists {
				state = "committed"
			}
			out = recordAttemptResult(baseID, recordID, guard.UserID, mutationID, savedID, state)
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if row.ID == 0 {
			return ErrNotFound
		}
		var parentAuthor int64
		if c.ParentID != nil {
			err = tx.QueryRow(ctx, `SELECT user_id FROM comments WHERE id=$1 AND doc_id=$2 AND block=$3 AND parent_id IS NULL FOR SHARE`, *c.ParentID, baseID, c.Block).Scan(&parentAuthor)
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			if err != nil {
				return err
			}
		}
		readers, err := pgRecordReadersLocked(ctx, tx, baseID, row, append(append([]int64(nil), c.Mentions...), parentAuthor))
		if err != nil {
			return err
		}
		mentions := make([]int64, 0, len(c.Mentions))
		for _, uid := range c.Mentions {
			if readers[uid] {
				mentions = append(mentions, uid)
			}
		}
		c.Mentions = mentions
		if parentAuthor > 0 && !readers[parentAuthor] {
			ctx = WithNotifySkip(ctx, []int64{parentAuthor})
		}
		err = tx.QueryRow(ctx, `INSERT INTO comments (doc_id,user_id,parent_id,block,start_char,end_char,quote,body,mentions) VALUES ($1,$2,$3,$4,'','','',$5,$6) RETURNING id,created_at,updated_at`, baseID, c.UserID, c.ParentID, c.Block, c.Body, c.Mentions).Scan(&c.ID, &c.CreatedAt, &c.UpdatedAt)
		if err != nil {
			return err
		}
		if err = insertCommentNotificationsTx(ctx, tx, c, guard.UserID, parentAuthor, false); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO record_comment_attempt_receipts(base_id,user_id,mutation_id,record_id,request_hash,comment_id) VALUES ($1,$2,$3,$4,$5,$6)`, baseID, guard.UserID, mutationID, recordID, digest[:], c.ID); err != nil {
			return err
		}
		if !guard.currentTime().Before(expires) {
			return ErrUnauthenticated
		}
		out = recordAttemptResult(baseID, recordID, guard.UserID, mutationID, c.ID, "committed")
		return nil
	})
	if retryableRestoreConflict(err) {
		err = ErrConflict
	}
	if err != nil {
		out = RecordCommentAttemptResult{}
	}
	return out, err
}

func (p *Postgres) GetRecordCommentAttempt(ctx context.Context, guard RestoreGuard, baseID, recordID int64, mutationID string) (out RecordCommentAttemptResult, err error) {
	if baseID <= 0 || recordID <= 0 || !commentMutationID.MatchString(mutationID) {
		return out, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, _, err := lockRecordCommentBase(ctx, tx, guard, baseID, recordID, false)
		if err != nil {
			return err
		}
		var savedRecord, savedID int64
		err = tx.QueryRow(ctx, `SELECT record_id,comment_id FROM record_comment_attempt_receipts WHERE base_id=$1 AND user_id=$2 AND mutation_id=$3`, baseID, guard.UserID, mutationID).Scan(&savedRecord, &savedID)
		if errors.Is(err, pgx.ErrNoRows) || err == nil && savedRecord != recordID {
			if !guard.currentTime().Before(expires) {
				return ErrUnauthenticated
			}
			out = recordAttemptResult(baseID, recordID, guard.UserID, mutationID, 0, "unknown")
			return nil
		}
		if err != nil {
			return err
		}
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM comments WHERE id=$1 AND doc_id=$2)`, savedID, baseID).Scan(&exists); err != nil {
			return err
		}
		if !guard.currentTime().Before(expires) {
			return ErrUnauthenticated
		}
		state := "deleted"
		if exists {
			state = "committed"
		}
		out = recordAttemptResult(baseID, recordID, guard.UserID, mutationID, savedID, state)
		return nil
	})
	if retryableRestoreConflict(err) {
		err = ErrConflict
	}
	if err != nil {
		out = RecordCommentAttemptResult{}
	}
	return out, err
}
