-- Spreadsheet advanced analysis & collaboration:
-- 1. Worksheet-scoped JSONB rules for data validation, conditional formatting,
--    and protected cell ranges (enforced server-side on WriteSheetCells).
-- 2. Cell-anchored comments bound to durable (worksheet_id, row_id, column_id)
--    axis IDs so comments survive row/column insertions and deletions.

ALTER TABLE sheet_worksheets
  ADD COLUMN IF NOT EXISTS validations jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS conditional_formats jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS protected_ranges jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS sheet_comments (
  id           BIGSERIAL PRIMARY KEY,
  node_id      BIGINT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  worksheet_id BIGINT NOT NULL REFERENCES sheet_worksheets(id) ON DELETE CASCADE,
  row_id       BIGINT NOT NULL,
  column_id    BIGINT NOT NULL,
  author_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body         TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  resolved     BOOLEAN NOT NULL DEFAULT false,
  resolved_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (worksheet_id, row_id) REFERENCES sheet_rows(worksheet_id, id) ON DELETE CASCADE,
  FOREIGN KEY (worksheet_id, column_id) REFERENCES sheet_columns(worksheet_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS sheet_comments_node_ws_idx
  ON sheet_comments(node_id, worksheet_id, created_at ASC, id ASC);
