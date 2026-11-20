-- Wiki shortcuts (跨库与云盘快捷方式引用):
-- persistent pointers inside a Wiki space directory tree referencing any
-- accessible target node (another Wiki space page or a Cloud Drive resource).
-- Target metadata and access are always re-checked live per caller on read so
-- revoking or deleting a target never leaks titles or metadata.
CREATE TABLE IF NOT EXISTS wiki_shortcuts (
  id             BIGSERIAL PRIMARY KEY,
  workspace_id   BIGINT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  wiki_space_id  BIGINT NOT NULL REFERENCES wiki_spaces(id) ON DELETE CASCADE,
  parent_id      BIGINT REFERENCES nodes(id) ON DELETE CASCADE,
  target_node_id BIGINT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  title          TEXT NOT NULL DEFAULT '' CHECK (char_length(title) <= 100),
  sort_key       TEXT NOT NULL DEFAULT 'V',
  creator_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wiki_shortcuts_space_idx
  ON wiki_shortcuts(wiki_space_id, parent_id, sort_key, id);

CREATE INDEX IF NOT EXISTS wiki_shortcuts_target_idx
  ON wiki_shortcuts(target_node_id);
