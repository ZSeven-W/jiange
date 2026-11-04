-- Docs v2: comments anchored to character ids + a notification center.
-- Anchors store the op ids of the commented range's first/last chars so they
-- survive concurrent edits (the quote text is kept for display).
CREATE TABLE comments (
    id         bigserial PRIMARY KEY,
    doc_id     bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    user_id    bigint NOT NULL REFERENCES users(id),
    parent_id  bigint REFERENCES comments(id) ON DELETE CASCADE,
    block      text NOT NULL DEFAULT '',
    start_char text NOT NULL DEFAULT '',
    end_char   text NOT NULL DEFAULT '',
    quote      text NOT NULL DEFAULT '',
    body       text NOT NULL,
    mentions   bigint[] NOT NULL DEFAULT '{}',
    resolved   bool NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_doc ON comments (doc_id, id);

CREATE TABLE notifications (
    id         bigserial PRIMARY KEY,
    user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    doc_id     bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    comment_id bigint REFERENCES comments(id) ON DELETE CASCADE,
    actor_id   bigint NOT NULL REFERENCES users(id),
    kind       text NOT NULL CHECK (kind IN ('mention', 'reply', 'resolve', 'restore')),
    preview    text NOT NULL DEFAULT '',
    read       bool NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user ON notifications (user_id, read, id);
