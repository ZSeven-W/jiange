-- A cancellation fences the request ID under the same document-head lock as
-- conditional commits, so a delayed request cannot commit after cancellation.
CREATE TABLE doc_conditional_ops_cancellations (
    doc_id bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id text NOT NULL CHECK (request_id ~ '^[0-9a-f]{32}$'),
    history_epoch bigint NOT NULL CHECK (history_epoch >= 1),
    base_seq bigint NOT NULL CHECK (base_seq >= 0),
    op_count integer NOT NULL CHECK (op_count > 0),
    client_id bigint NOT NULL CHECK (client_id > 0),
    digest bytea NOT NULL CHECK (octet_length(digest) = 32),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (doc_id, user_id, request_id)
);
