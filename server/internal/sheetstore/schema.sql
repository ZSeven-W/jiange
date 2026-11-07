-- Experimental standalone spreadsheet storage. This schema is intentionally
-- not included in the application's migration set or exposed by the API. A
-- future integration must add explicit node kinds and a client-version fence.
CREATE TABLE sheet_workbooks (
  id BIGSERIAL PRIMARY KEY,
  workspace_id BIGINT NOT NULL REFERENCES workspaces(id),
  creator_id BIGINT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE sheet_grants (
  workbook_id BIGINT NOT NULL REFERENCES sheet_workbooks(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('view', 'edit', 'manage')),
  PRIMARY KEY (workbook_id, user_id)
);
CREATE TABLE sheet_worksheets (
  id BIGSERIAL PRIMARY KEY,
  workbook_id BIGINT NOT NULL REFERENCES sheet_workbooks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  UNIQUE (workbook_id, position)
);
CREATE TABLE sheet_rows (
  id BIGSERIAL PRIMARY KEY,
  sheet_id BIGINT NOT NULL REFERENCES sheet_worksheets(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  UNIQUE (sheet_id, id), UNIQUE (sheet_id, position)
);
CREATE TABLE sheet_columns (
  id BIGSERIAL PRIMARY KEY,
  sheet_id BIGINT NOT NULL REFERENCES sheet_worksheets(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  UNIQUE (sheet_id, id), UNIQUE (sheet_id, position)
);
-- Empty values are retained as revision tombstones. Deleting them would let a
-- stale write with expectedRevision=0 recreate a changed cell.
CREATE TABLE sheet_cells (
  sheet_id BIGINT NOT NULL REFERENCES sheet_worksheets(id) ON DELETE CASCADE,
  row_id BIGINT NOT NULL,
  column_id BIGINT NOT NULL,
  raw TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  PRIMARY KEY (sheet_id, row_id, column_id),
  FOREIGN KEY (sheet_id, row_id) REFERENCES sheet_rows(sheet_id, id),
  FOREIGN KEY (sheet_id, column_id) REFERENCES sheet_columns(sheet_id, id)
);
CREATE TABLE sheet_write_receipts (
  workbook_id BIGINT NOT NULL REFERENCES sheet_workbooks(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id),
  mutation_id TEXT NOT NULL,
  digest BYTEA NOT NULL,
  result JSONB NOT NULL,
  PRIMARY KEY (workbook_id, user_id, mutation_id)
);
CREATE TABLE sheet_create_receipts (
  workspace_id BIGINT NOT NULL REFERENCES workspaces(id),
  user_id BIGINT NOT NULL REFERENCES users(id),
  mutation_id TEXT NOT NULL,
  digest BYTEA NOT NULL,
  workbook_id BIGINT NOT NULL REFERENCES sheet_workbooks(id),
  PRIMARY KEY (workspace_id, user_id, mutation_id)
);
