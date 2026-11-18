-- Enterprise organization structure (departments & user groups),
-- subject-based node sharing, and per-node inheritance boundary.
CREATE TABLE org_departments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id bigint REFERENCES org_departments(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX org_departments_ws_parent_idx ON org_departments (workspace_id, parent_id, sort_order, id);

CREATE TABLE org_department_members (
  department_id bigint NOT NULL REFERENCES org_departments(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_leader boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (department_id, user_id)
);
CREATE INDEX org_department_members_user_idx ON org_department_members (user_id);

CREATE TABLE org_groups (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX org_groups_ws_idx ON org_groups (workspace_id, id);

CREATE TABLE org_group_members (
  group_id bigint NOT NULL REFERENCES org_groups(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX org_group_members_user_idx ON org_group_members (user_id);

CREATE TABLE node_subject_shares (
  doc_id bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  subject_type text NOT NULL CHECK (subject_type IN ('department', 'group')),
  subject_id bigint NOT NULL CHECK (subject_id > 0),
  role text NOT NULL CHECK (role IN ('view', 'edit', 'manage')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_id, subject_type, subject_id)
);
CREATE INDEX node_subject_shares_subject_idx ON node_subject_shares (subject_type, subject_id);

ALTER TABLE nodes ADD COLUMN inherit_parent_acl boolean NOT NULL DEFAULT true;
