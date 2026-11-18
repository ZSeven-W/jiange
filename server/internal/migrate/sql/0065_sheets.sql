-- Standalone multi-worksheet spreadsheet node kind (`sheet`), integrated with
-- drive nodes, workspace permissions, copy/trash/restore, and versioned mutations.
ALTER TABLE nodes DROP CONSTRAINT nodes_kind_check;
ALTER TABLE nodes ADD CONSTRAINT nodes_kind_check CHECK (kind IN ('doc', 'base', 'folder', 'slides', 'file', 'sheet'));

CREATE TABLE sheet_workbooks (
  node_id bigint PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1 AND revision <= 9007199254740991),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sheet_worksheets (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  node_id bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 31),
  pos integer NOT NULL CHECK (pos >= 0),
  frozen_rows integer NOT NULL DEFAULT 0 CHECK (frozen_rows >= 0 AND frozen_rows <= 50),
  frozen_cols integer NOT NULL DEFAULT 0 CHECK (frozen_cols >= 0 AND frozen_cols <= 20),
  merges jsonb NOT NULL DEFAULT '[]'::jsonb,
  filter_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1 AND revision <= 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sheet_worksheets_node_pos_unique UNIQUE (node_id, pos) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX sheet_worksheets_order ON sheet_worksheets (node_id, pos, id);

CREATE TABLE sheet_rows (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  worksheet_id bigint NOT NULL REFERENCES sheet_worksheets(id) ON DELETE CASCADE,
  pos integer NOT NULL CHECK (pos >= 0),
  size integer NOT NULL DEFAULT 0 CHECK (size >= 0 AND size <= 2000),
  UNIQUE (worksheet_id, id),
  CONSTRAINT sheet_rows_pos_unique UNIQUE (worksheet_id, pos) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX sheet_rows_order ON sheet_rows (worksheet_id, pos, id);

CREATE TABLE sheet_columns (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  worksheet_id bigint NOT NULL REFERENCES sheet_worksheets(id) ON DELETE CASCADE,
  pos integer NOT NULL CHECK (pos >= 0),
  size integer NOT NULL DEFAULT 0 CHECK (size >= 0 AND size <= 2000),
  UNIQUE (worksheet_id, id),
  CONSTRAINT sheet_columns_pos_unique UNIQUE (worksheet_id, pos) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX sheet_columns_order ON sheet_columns (worksheet_id, pos, id);

-- Empty values with styles or cleared cells are retained as revision tombstones
-- so stale writes with expectedRevision=0 cannot resurrect overwritten content.
CREATE TABLE sheet_cells (
  worksheet_id bigint NOT NULL REFERENCES sheet_worksheets(id) ON DELETE CASCADE,
  row_id bigint NOT NULL,
  column_id bigint NOT NULL,
  raw text NOT NULL DEFAULT '' CHECK (octet_length(raw) <= 32768),
  style jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision bigint NOT NULL CHECK (revision >= 1 AND revision <= 9007199254740991),
  updated_by bigint REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (worksheet_id, row_id, column_id),
  FOREIGN KEY (worksheet_id, row_id) REFERENCES sheet_rows(worksheet_id, id) ON DELETE CASCADE,
  FOREIGN KEY (worksheet_id, column_id) REFERENCES sheet_columns(worksheet_id, id) ON DELETE CASCADE
);

CREATE TABLE sheet_write_receipts (
  node_id bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mutation_id text NOT NULL CHECK (mutation_id ~ '^[a-f0-9]{32}$'),
  digest bytea NOT NULL CHECK (octet_length(digest) = 32),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, user_id, mutation_id)
);
