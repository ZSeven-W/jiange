-- Retain receipts after comment deletion so a delayed retry cannot recreate a
-- deleted comment or its notifications. The document/user own the identity.
CREATE TABLE comment_attempt_receipts (
    doc_id bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mutation_id text NOT NULL CHECK (mutation_id ~ '^[0-9a-f]{32}$'),
    request_hash bytea NOT NULL CHECK (octet_length(request_hash)=32),
    comment_id bigint NOT NULL CHECK (comment_id > 0),
    PRIMARY KEY (doc_id, user_id, mutation_id)
);
