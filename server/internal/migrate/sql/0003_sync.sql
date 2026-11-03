-- P2: sync server bookkeeping.
ALTER TABLE nodes ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- One row per document: the last assigned sequence number. Appends lock this
-- row, so sequence numbers are gap-free and totally ordered across instances.
CREATE TABLE doc_heads (
    doc_id bigint PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
    seq    bigint NOT NULL DEFAULT 0
);

-- Replica ids. Each editor session (browser tab) gets one; acked_seq drives
-- the tombstone-GC horizon.
CREATE TABLE doc_clients (
    id         bigserial PRIMARY KEY,
    doc_id     bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    acked_seq  bigint NOT NULL DEFAULT 0,
    last_seen  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX doc_clients_doc ON doc_clients (doc_id, last_seen);

ALTER TABLE doc_ops ADD COLUMN clock bigint NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX doc_ops_identity ON doc_ops (doc_id, client_id, clock);
