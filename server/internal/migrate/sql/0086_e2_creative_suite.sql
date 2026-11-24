-- Route E2: Creative Suite Upgrades & Cloud Defined Names
-- 1. Cloud-persisted workbook defined names for Sheets.
-- 2. Slides page/element review comments.
-- 3. Slides deck version history snapshots.

CREATE TABLE IF NOT EXISTS sheet_defined_names (
    sheet_id      BIGINT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
    defined_names JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_by    BIGINT REFERENCES users(id) ON DELETE SET NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS slides_comments (
    id          BIGSERIAL PRIMARY KEY,
    slides_id   BIGINT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    page_id     BIGINT NOT NULL,
    shape_id    TEXT NOT NULL DEFAULT '',
    author_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
    author_name TEXT NOT NULL DEFAULT '',
    body        TEXT NOT NULL,
    resolved    BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_slides_comments_slides
    ON slides_comments(slides_id, page_id, created_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS slides_versions (
    id         BIGSERIAL PRIMARY KEY,
    slides_id  BIGINT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    label      TEXT NOT NULL DEFAULT '',
    auto_saved BOOLEAN NOT NULL DEFAULT false,
    snapshot   JSONB NOT NULL,
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    actor_name TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_slides_versions_slides
    ON slides_versions(slides_id, created_at DESC, id DESC);
