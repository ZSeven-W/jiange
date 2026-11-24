-- Cloud persistence for Doc bottom reactions and Slides page metadata
-- (title/body text styles, page transitions, and shape groups).
CREATE TABLE IF NOT EXISTS doc_reactions (
    doc_id     BIGINT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (doc_id, user_id, emoji)
);

CREATE INDEX IF NOT EXISTS idx_doc_reactions_doc ON doc_reactions(doc_id);

ALTER TABLE slides_pages
    ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb;
