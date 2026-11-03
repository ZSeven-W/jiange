-- P4: per-doc sharing (three roles), link sharing, attachments.
CREATE TABLE doc_shares (
    doc_id  bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role    text NOT NULL CHECK (role IN ('view', 'edit', 'manage')),
    PRIMARY KEY (doc_id, user_id)
);
CREATE INDEX doc_shares_user ON doc_shares (user_id);

ALTER TABLE nodes ADD COLUMN link_role text NOT NULL DEFAULT 'none' CHECK (link_role IN ('none', 'view', 'edit'));
ALTER TABLE nodes ADD COLUMN link_token text UNIQUE;

CREATE TABLE attachments (
    id          bigserial PRIMARY KEY,
    doc_id      bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    uploader_id bigint NOT NULL REFERENCES users(id),
    name        text NOT NULL,
    mime        text NOT NULL,
    size        bigint NOT NULL,
    object_key  text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
