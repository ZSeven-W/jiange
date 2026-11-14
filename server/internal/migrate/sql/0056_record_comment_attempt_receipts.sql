-- A record comment receipt is separate from document-comment receipts: an
-- ordinary document receipt endpoint must never reveal a restricted row.
-- Keep the receipt after a record/comment is deleted so retries cannot
-- recreate either the comment or its notifications.
CREATE TABLE record_comment_attempt_receipts (
    base_id bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mutation_id text NOT NULL CHECK (mutation_id ~ '^[0-9a-f]{32}$'),
    record_id bigint NOT NULL CHECK (record_id > 0),
    request_hash bytea NOT NULL CHECK (octet_length(request_hash)=32),
    comment_id bigint NOT NULL CHECK (comment_id > 0),
    PRIMARY KEY (base_id, user_id, mutation_id)
);
