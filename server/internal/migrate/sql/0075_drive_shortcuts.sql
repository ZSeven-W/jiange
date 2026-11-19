-- Drive shortcuts: persistent pointers in a Drive folder to any accessible
-- node (doc, board, sheet, base, slides, survey, folder, or file).
-- Access to the target node is always re-checked live on read so revoking or
-- deleting the target never leaks metadata or content through the shortcut.
CREATE TABLE IF NOT EXISTS drive_shortcuts (
  id             BIGSERIAL PRIMARY KEY,
  workspace_id   BIGINT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id      BIGINT REFERENCES nodes(id) ON DELETE CASCADE,
  personal       BOOLEAN NOT NULL DEFAULT false,
  target_node_id BIGINT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  title          TEXT NOT NULL DEFAULT '',
  creator_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS drive_shortcuts_parent_idx
  ON drive_shortcuts(workspace_id, parent_id, personal);

CREATE INDEX IF NOT EXISTS drive_shortcuts_target_idx
  ON drive_shortcuts(target_node_id);
