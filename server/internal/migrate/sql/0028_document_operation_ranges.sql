-- Each post-migration operation must be accompanied by its identity range in
-- the same transaction. Existing operation rows are indexed lazily by client.
-- Deploy only after all older writers are drained: new rows from older writers
-- fail at commit, but their duplicate-only retries can still be falsely acked.
CREATE TABLE doc_op_ranges (
    doc_id bigint NOT NULL,
    seq bigint NOT NULL,
    client_id bigint NOT NULL,
    clock bigint NOT NULL,
    end_clock bigint NOT NULL CHECK (end_clock >= clock),
    decoded boolean NOT NULL,
    PRIMARY KEY (doc_id, seq),
    UNIQUE (doc_id, seq, client_id, clock),
    UNIQUE (doc_id, client_id, clock),
    FOREIGN KEY (doc_id, seq) REFERENCES doc_ops(doc_id, seq)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE doc_op_range_clients (
    doc_id bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    client_id bigint NOT NULL,
    has_opaque boolean NOT NULL DEFAULT false,
    PRIMARY KEY (doc_id, client_id)
);
-- NOT VALID leaves existing unindexed rows readable while enforcing the gate
-- for new inserts. Its purpose is compatibility fencing, not protection
-- against a database owner who can forge or disable constraints.
ALTER TABLE doc_ops ADD CONSTRAINT doc_ops_range_required
    FOREIGN KEY (doc_id, seq, client_id, clock)
    REFERENCES doc_op_ranges(doc_id, seq, client_id, clock)
    DEFERRABLE INITIALLY DEFERRED NOT VALID;
