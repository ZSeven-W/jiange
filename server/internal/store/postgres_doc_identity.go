package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// ensureOperationClientIndex is called while the document head is locked.
// Existing logs are indexed only after the complete client's history has been
// validated. A damaged history is left untouched and fails closed.
func ensureOperationClientIndex(ctx context.Context, tx pgx.Tx, doc, client int64) (bool, error) {
	var opaque bool
	err := tx.QueryRow(ctx, `SELECT has_opaque FROM doc_op_range_clients WHERE doc_id=$1 AND client_id=$2`, doc, client).Scan(&opaque)
	if err == nil {
		return opaque, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return false, err
	}
	// No marker and existing ranges cannot result from an interrupted indexed
	// write: both are transactional. Preserve such data for investigation.
	var unexpected bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM doc_op_ranges WHERE doc_id=$1 AND client_id=$2)`, doc, client).Scan(&unexpected); err != nil {
		return false, err
	}
	if unexpected {
		return false, ErrOpIdentityConflict
	}

	rows, err := tx.Query(ctx, `SELECT seq, clock, op FROM doc_ops WHERE doc_id=$1 AND client_id=$2 ORDER BY clock`, doc, client)
	if err != nil {
		return false, err
	}
	type indexed struct {
		seq, clock, end int64
		decoded         bool
	}
	var records []indexed
	var lastEnd int64
	first := true
	for rows.Next() {
		var seq int64
		raw := RawOp{ClientID: client}
		if err := rows.Scan(&seq, &raw.Clock, &raw.Bytes); err != nil {
			rows.Close()
			return false, err
		}
		end, _, decoded, err := opIdentity(raw)
		if err != nil || (!first && raw.Clock <= lastEnd) {
			rows.Close()
			return false, ErrOpIdentityConflict
		}
		first, lastEnd = false, end
		opaque = opaque || !decoded
		records = append(records, indexed{seq, raw.Clock, end, decoded})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return false, err
	}
	if len(records) != 0 {
		_, err = tx.CopyFrom(ctx, pgx.Identifier{"doc_op_ranges"}, []string{"doc_id", "seq", "client_id", "clock", "end_clock", "decoded"}, pgx.CopyFromSlice(len(records), func(i int) ([]any, error) {
			r := records[i]
			return []any{doc, r.seq, client, r.clock, r.end, r.decoded}, nil
		}))
		if err != nil {
			return false, err
		}
	}
	_, err = tx.Exec(ctx, `INSERT INTO doc_op_range_clients(doc_id,client_id,has_opaque) VALUES ($1,$2,$3)`, doc, client, opaque)
	return opaque, err
}

// checkOperationIdentity performs an indexed predecessor lookup. This is safe
// only after ensureOperationClientIndex has proved disjoint historical ranges.
func checkOperationIdentity(ctx context.Context, tx pgx.Tx, doc int64, op RawOp) (bool, error) {
	end, _, valid, err := opIdentity(op)
	if err != nil {
		return false, err
	}
	opaque, err := ensureOperationClientIndex(ctx, tx, doc, op.ClientID)
	if err != nil {
		return false, err
	}
	if valid && opaque {
		return false, ErrOpIdentityConflict
	}
	old := RawOp{ClientID: op.ClientID}
	var oldEnd int64
	err = tx.QueryRow(ctx, `SELECT r.clock, r.end_clock, o.op FROM doc_op_ranges r
        JOIN doc_ops o ON o.doc_id=r.doc_id AND o.seq=r.seq
        WHERE r.doc_id=$1 AND r.client_id=$2 AND r.clock <= $3
        ORDER BY r.clock DESC LIMIT 1`, doc, op.ClientID, end).Scan(&old.Clock, &oldEnd, &old.Bytes)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if oldEnd < op.Clock {
		return false, nil
	}
	return compareIdentity(op, old)
}

// insertOperationRange must follow insertion of the matching doc_ops row in
// the same transaction. The deferred FK prevents legacy writers from
// committing rows without a corresponding identity entry.
func insertOperationRange(ctx context.Context, tx pgx.Tx, doc, seq int64, op RawOp) error {
	end, _, decoded, err := opIdentity(op)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO doc_op_ranges(doc_id,seq,client_id,clock,end_clock,decoded) VALUES ($1,$2,$3,$4,$5,$6)`, doc, seq, op.ClientID, op.Clock, end, decoded); err != nil {
		return err
	}
	if !decoded {
		_, err = tx.Exec(ctx, `UPDATE doc_op_range_clients SET has_opaque=true WHERE doc_id=$1 AND client_id=$2`, doc, op.ClientID)
	}
	return err
}
