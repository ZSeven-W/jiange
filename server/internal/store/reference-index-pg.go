package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

func (p *Postgres) GetReferenceIndexStates(ctx context.Context, sourceIDs []int64) (map[int64]ReferenceIndexState, error) {
	out := make(map[int64]ReferenceIndexState, len(sourceIDs))
	if len(sourceIDs) == 0 {
		return out, nil
	}
	rows, err := p.Pool.Query(ctx, `
		SELECT source_node_id, source_kind, source_epoch, source_seq, source_stamp, indexed_at
		FROM doc_reference_index_state
		WHERE source_node_id = ANY($1)
	`, sourceIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var st ReferenceIndexState
		if err := rows.Scan(&st.SourceNodeID, &st.SourceKind, &st.SourceEpoch, &st.SourceSeq, &st.SourceStamp, &st.IndexedAt); err != nil {
			return nil, err
		}
		out[st.SourceNodeID] = st
	}
	return out, rows.Err()
}

func (p *Postgres) ReplaceReferenceEdges(ctx context.Context, state ReferenceIndexState, edges []ReferenceEdge) error {
	return pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var exists int64
		if err := tx.QueryRow(ctx, `SELECT id FROM nodes WHERE id = $1 AND deleted_at IS NULL`, state.SourceNodeID).Scan(&exists); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				// Node was deleted or purged concurrently; drop any stale index rows.
				_, _ = tx.Exec(ctx, `DELETE FROM doc_reference_edges WHERE source_node_id = $1`, state.SourceNodeID)
				_, _ = tx.Exec(ctx, `DELETE FROM doc_reference_index_state WHERE source_node_id = $1`, state.SourceNodeID)
				return nil
			}
			return err
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO doc_reference_index_state (source_node_id, source_kind, source_epoch, source_seq, source_stamp, indexed_at)
			VALUES ($1, $2, $3, $4, $5, now())
			ON CONFLICT (source_node_id) DO UPDATE SET
				source_kind = EXCLUDED.source_kind,
				source_epoch = EXCLUDED.source_epoch,
				source_seq = EXCLUDED.source_seq,
				source_stamp = EXCLUDED.source_stamp,
				indexed_at = now()
		`, state.SourceNodeID, state.SourceKind, state.SourceEpoch, state.SourceSeq, state.SourceStamp)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM doc_reference_edges WHERE source_node_id = $1`, state.SourceNodeID); err != nil {
			return err
		}
		if len(edges) == 0 {
			return nil
		}
		batch := &pgx.Batch{}
		for _, e := range edges {
			rel := e.RelationKind
			if rel == "" {
				rel = "link"
			}
			batch.Queue(`
				INSERT INTO doc_reference_edges
					(source_node_id, target_node_id, target_token, target_scheme, source_block, excerpt, relation_kind)
				VALUES ($1, $2, $3, $4, $5, $6, $7)
			`, state.SourceNodeID, e.TargetNodeID, e.TargetToken, e.TargetScheme, e.SourceBlock, e.Excerpt, rel)
		}
		br := tx.SendBatch(ctx, batch)
		for range edges {
			if _, err := br.Exec(); err != nil {
				_ = br.Close()
				return err
			}
		}
		return br.Close()
	})
}

func (p *Postgres) ListOutgoingReferenceEdges(ctx context.Context, sourceIDs []int64) ([]ReferenceEdge, error) {
	if len(sourceIDs) == 0 {
		return []ReferenceEdge{}, nil
	}
	rows, err := p.Pool.Query(ctx, `
		SELECT e.source_node_id, e.target_node_id, e.target_token, e.target_scheme, e.source_block, e.excerpt, e.relation_kind
		FROM doc_reference_edges e
		JOIN nodes n ON n.id = e.source_node_id AND n.deleted_at IS NULL
		WHERE e.source_node_id = ANY($1)
		ORDER BY e.source_node_id, e.id
	`, sourceIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ReferenceEdge{}
	for rows.Next() {
		var e ReferenceEdge
		if err := rows.Scan(&e.SourceNodeID, &e.TargetNodeID, &e.TargetToken, &e.TargetScheme, &e.SourceBlock, &e.Excerpt, &e.RelationKind); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func (p *Postgres) ListIncomingReferenceEdges(ctx context.Context, targetIDs []int64, targetTokens []string) ([]ReferenceEdge, error) {
	if len(targetIDs) == 0 && len(targetTokens) == 0 {
		return []ReferenceEdge{}, nil
	}
	if targetIDs == nil {
		targetIDs = []int64{}
	}
	if targetTokens == nil {
		targetTokens = []string{}
	}
	rows, err := p.Pool.Query(ctx, `
		SELECT e.source_node_id, e.target_node_id, e.target_token, e.target_scheme, e.source_block, e.excerpt, e.relation_kind
		FROM doc_reference_edges e
		JOIN nodes n ON n.id = e.source_node_id AND n.deleted_at IS NULL
		WHERE (e.target_node_id > 0 AND e.target_node_id = ANY($1))
		   OR (e.target_token <> '' AND e.target_token = ANY($2))
		ORDER BY e.source_node_id, e.id
	`, targetIDs, targetTokens)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ReferenceEdge{}
	for rows.Next() {
		var e ReferenceEdge
		if err := rows.Scan(&e.SourceNodeID, &e.TargetNodeID, &e.TargetToken, &e.TargetScheme, &e.SourceBlock, &e.Excerpt, &e.RelationKind); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func (p *Postgres) ListNodeLinkTokens(ctx context.Context, nodeIDs []int64) (map[int64]string, error) {
	out := map[int64]string{}
	if len(nodeIDs) == 0 {
		return out, nil
	}
	rows, err := p.Pool.Query(ctx, `
		SELECT id, link_token
		FROM nodes
		WHERE id = ANY($1) AND deleted_at IS NULL AND link_token <> '' AND link_role <> 'none'
	`, nodeIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var tok string
		if err := rows.Scan(&id, &tok); err != nil {
			return nil, err
		}
		out[id] = tok
	}
	return out, rows.Err()
}

func (p *Postgres) ListDocHeadVersions(ctx context.Context, docIDs []int64) (map[int64][2]int64, error) {
	out := make(map[int64][2]int64, len(docIDs))
	if len(docIDs) == 0 {
		return out, nil
	}
	rows, err := p.Pool.Query(ctx, `
		SELECT doc_id, history_epoch, seq
		FROM doc_heads
		WHERE doc_id = ANY($1)
	`, docIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, epoch, seq int64
		if err := rows.Scan(&id, &epoch, &seq); err != nil {
			return nil, err
		}
		out[id] = [2]int64{epoch, seq}
	}
	return out, rows.Err()
}

func (p *Postgres) ListSheetWorkbookRevisions(ctx context.Context, sheetIDs []int64) (map[int64]int64, error) {
	out := make(map[int64]int64, len(sheetIDs))
	if len(sheetIDs) == 0 {
		return out, nil
	}
	rows, err := p.Pool.Query(ctx, `
		SELECT node_id, revision
		FROM sheet_workbooks
		WHERE node_id = ANY($1)
	`, sheetIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, rev int64
		if err := rows.Scan(&id, &rev); err != nil {
			return nil, err
		}
		out[id] = rev
	}
	return out, rows.Err()
}
