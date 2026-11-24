-- Route P0 + E1:
-- 1. Share link access passwords (per-doc hashed passcode for public/join links).
-- 2. Sheet workbook version history snapshots (named + auto pre-restore backups).
-- 3. Sheet cell edit history timeline (before/after value & formula audit trail).

CREATE TABLE IF NOT EXISTS doc_link_passwords (
    doc_id        BIGINT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
    password_hash TEXT NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sheet_versions (
    id         BIGSERIAL PRIMARY KEY,
    sheet_id   BIGINT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    label      TEXT NOT NULL DEFAULT '',
    auto_saved BOOLEAN NOT NULL DEFAULT false,
    snapshot   JSONB NOT NULL,
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    actor_name TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sheet_versions_sheet
    ON sheet_versions(sheet_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS sheet_cell_history (
    id           BIGSERIAL PRIMARY KEY,
    sheet_id     BIGINT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    worksheet_id BIGINT NOT NULL,
    row_idx      INT NOT NULL,
    col_idx      INT NOT NULL,
    prev_value   TEXT NOT NULL DEFAULT '',
    next_value   TEXT NOT NULL DEFAULT '',
    prev_formula TEXT NOT NULL DEFAULT '',
    next_formula TEXT NOT NULL DEFAULT '',
    actor_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,
    actor_name   TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sheet_cell_history_cell
    ON sheet_cell_history(sheet_id, worksheet_id, row_idx, col_idx, created_at DESC, id DESC);
