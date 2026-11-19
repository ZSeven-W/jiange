-- Independent Wiki Knowledge Spaces (知识库空间):
-- spaces with workspace/private visibility, subject-based space grants
-- (user/department/group -> view/edit/manage), and nodes.wiki_space_id
-- separating Wiki page trees from Drive directory listings.
CREATE TABLE wiki_spaces (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  icon text NOT NULL DEFAULT '' CHECK (char_length(icon) <= 64),
  visibility text NOT NULL DEFAULT 'workspace' CHECK (visibility IN ('workspace', 'private')),
  creator_id bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wiki_spaces_workspace_idx ON wiki_spaces (workspace_id, id);

CREATE TABLE wiki_space_grants (
  space_id bigint NOT NULL REFERENCES wiki_spaces(id) ON DELETE CASCADE,
  subject_type text NOT NULL CHECK (subject_type IN ('user', 'department', 'group')),
  subject_id bigint NOT NULL CHECK (subject_id > 0),
  role text NOT NULL CHECK (role IN ('view', 'edit', 'manage')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, subject_type, subject_id)
);
CREATE INDEX wiki_space_grants_subject_idx ON wiki_space_grants (subject_type, subject_id);

ALTER TABLE nodes ADD COLUMN wiki_space_id bigint REFERENCES wiki_spaces(id) ON DELETE CASCADE;
ALTER TABLE nodes ADD CONSTRAINT nodes_wiki_not_personal_check CHECK (wiki_space_id IS NULL OR NOT personal);
CREATE INDEX nodes_wiki_space_idx ON nodes (wiki_space_id, parent_id, sort_key, id)
  WHERE wiki_space_id IS NOT NULL AND deleted_at IS NULL;
