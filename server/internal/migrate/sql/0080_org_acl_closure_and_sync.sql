-- Materialized department & node ACL inheritance closures for O(1)-probe
-- large-workspace listing/search permission checks, plus external enterprise
-- organization directory sync connectors and audit runs.

CREATE TABLE org_department_closure (
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ancestor_id bigint NOT NULL REFERENCES org_departments(id) ON DELETE CASCADE,
  descendant_id bigint NOT NULL REFERENCES org_departments(id) ON DELETE CASCADE,
  depth integer NOT NULL CHECK (depth >= 0),
  PRIMARY KEY (descendant_id, ancestor_id)
);
CREATE INDEX org_department_closure_ws_anc_idx ON org_department_closure (workspace_id, ancestor_id, descendant_id);
CREATE INDEX org_department_closure_ws_desc_idx ON org_department_closure (workspace_id, descendant_id, ancestor_id);

WITH RECURSIVE dc AS (
  SELECT id AS descendant_id, id AS ancestor_id, workspace_id, parent_id, 0 AS depth, ARRAY[id] AS seen
  FROM org_departments
  UNION ALL
  SELECT dc.descendant_id, p.id AS ancestor_id, dc.workspace_id, p.parent_id, dc.depth + 1, dc.seen || p.id
  FROM dc
  JOIN org_departments p ON p.id = dc.parent_id AND p.workspace_id = dc.workspace_id
  WHERE NOT p.id = ANY(dc.seen)
)
INSERT INTO org_department_closure (workspace_id, ancestor_id, descendant_id, depth)
SELECT workspace_id, ancestor_id, descendant_id, depth FROM dc
ON CONFLICT (descendant_id, ancestor_id) DO NOTHING;

CREATE OR REPLACE FUNCTION sync_org_department_closure() RETURNS trigger AS $$
DECLARE
  sub_ids bigint[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO org_department_closure (workspace_id, ancestor_id, descendant_id, depth)
    VALUES (NEW.workspace_id, NEW.id, NEW.id, 0)
    ON CONFLICT (descendant_id, ancestor_id) DO NOTHING;
    IF NEW.parent_id IS NOT NULL THEN
      INSERT INTO org_department_closure (workspace_id, ancestor_id, descendant_id, depth)
      SELECT NEW.workspace_id, c.ancestor_id, NEW.id, c.depth + 1
      FROM org_department_closure c
      WHERE c.descendant_id = NEW.parent_id AND c.workspace_id = NEW.workspace_id
      ON CONFLICT (descendant_id, ancestor_id) DO NOTHING;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND (OLD.parent_id IS DISTINCT FROM NEW.parent_id OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id) THEN
    WITH RECURSIVE sub AS (
      SELECT NEW.id AS id, ARRAY[NEW.id] AS seen
      UNION ALL
      SELECT d.id, sub.seen || d.id
      FROM org_departments d
      JOIN sub ON d.parent_id = sub.id
      WHERE d.workspace_id = NEW.workspace_id AND NOT d.id = ANY(sub.seen)
    )
    SELECT array_agg(id ORDER BY id) INTO sub_ids FROM sub;

    DELETE FROM org_department_closure WHERE descendant_id = ANY(sub_ids);

    WITH RECURSIVE up AS (
      SELECT d.id AS descendant_id, d.id AS ancestor_id, d.workspace_id, d.parent_id, 0 AS depth, ARRAY[d.id] AS seen
      FROM org_departments d
      WHERE d.id = ANY(sub_ids)
      UNION ALL
      SELECT up.descendant_id, p.id AS ancestor_id, up.workspace_id, p.parent_id, up.depth + 1, up.seen || p.id
      FROM up
      JOIN org_departments p ON p.id = up.parent_id AND p.workspace_id = up.workspace_id
      WHERE NOT p.id = ANY(up.seen)
    )
    INSERT INTO org_department_closure (workspace_id, ancestor_id, descendant_id, depth)
    SELECT workspace_id, ancestor_id, descendant_id, depth FROM up
    ON CONFLICT (descendant_id, ancestor_id) DO UPDATE SET depth = EXCLUDED.depth, workspace_id = EXCLUDED.workspace_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER org_departments_closure_sync
AFTER INSERT OR UPDATE OF parent_id, workspace_id ON org_departments
FOR EACH ROW EXECUTE FUNCTION sync_org_department_closure();

-- Materialized effective ACL inheritance chain per node.
-- Intentionally omits foreign keys back to nodes(id) and maintains deletion via
-- the AFTER DELETE trigger below so moving or updating an ancestor never takes
-- implicit FOR KEY SHARE locks on descendant rows in nodes (which would block
-- concurrent SELECT ... FOR UPDATE operations on descendants).
CREATE TABLE node_acl_state (
  node_id bigint PRIMARY KEY,
  inherits_ws boolean NOT NULL DEFAULT true
);

CREATE TABLE node_acl_ancestors (
  node_id bigint NOT NULL,
  ancestor_id bigint NOT NULL,
  PRIMARY KEY (node_id, ancestor_id)
);
CREATE INDEX node_acl_ancestors_ancestor_idx ON node_acl_ancestors (ancestor_id, node_id);

WITH RECURSIVE na AS (
  SELECT id AS node_id, id AS ancestor_id, parent_id, inherit_parent_acl, ARRAY[id] AS seen
  FROM nodes
  UNION ALL
  SELECT na.node_id, p.id AS ancestor_id, p.parent_id, p.inherit_parent_acl, na.seen || p.id
  FROM na
  JOIN nodes p ON na.inherit_parent_acl AND p.id = na.parent_id
  WHERE NOT p.id = ANY(na.seen)
)
INSERT INTO node_acl_state (node_id, inherits_ws)
SELECT node_id, COALESCE(bool_and(inherit_parent_acl), true)
FROM na
GROUP BY node_id
ON CONFLICT (node_id) DO UPDATE SET inherits_ws = EXCLUDED.inherits_ws;

WITH RECURSIVE na AS (
  SELECT id AS node_id, id AS ancestor_id, parent_id, inherit_parent_acl, ARRAY[id] AS seen
  FROM nodes
  UNION ALL
  SELECT na.node_id, p.id AS ancestor_id, p.parent_id, p.inherit_parent_acl, na.seen || p.id
  FROM na
  JOIN nodes p ON na.inherit_parent_acl AND p.id = na.parent_id
  WHERE NOT p.id = ANY(na.seen)
)
INSERT INTO node_acl_ancestors (node_id, ancestor_id)
SELECT node_id, ancestor_id FROM na
ON CONFLICT (node_id, ancestor_id) DO NOTHING;

CREATE OR REPLACE FUNCTION sync_node_acl_closure() RETURNS trigger AS $$
DECLARE
  parent_inherits boolean;
  affected_ids bigint[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM node_acl_ancestors WHERE node_id = OLD.id OR ancestor_id = OLD.id;
    DELETE FROM node_acl_state WHERE node_id = OLD.id;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.parent_id IS NULL OR NOT NEW.inherit_parent_acl THEN
      INSERT INTO node_acl_state (node_id, inherits_ws)
      VALUES (NEW.id, NEW.inherit_parent_acl)
      ON CONFLICT (node_id) DO UPDATE SET inherits_ws = EXCLUDED.inherits_ws;

      INSERT INTO node_acl_ancestors (node_id, ancestor_id)
      VALUES (NEW.id, NEW.id)
      ON CONFLICT DO NOTHING;
    ELSE
      SELECT inherits_ws INTO parent_inherits FROM node_acl_state WHERE node_id = NEW.parent_id;
      IF parent_inherits IS NULL THEN
        parent_inherits := true;
      END IF;
      INSERT INTO node_acl_state (node_id, inherits_ws)
      VALUES (NEW.id, parent_inherits)
      ON CONFLICT (node_id) DO UPDATE SET inherits_ws = EXCLUDED.inherits_ws;

      INSERT INTO node_acl_ancestors (node_id, ancestor_id)
      SELECT NEW.id, NEW.id
      UNION
      SELECT NEW.id, a.ancestor_id
      FROM node_acl_ancestors a
      WHERE a.node_id = NEW.parent_id
      ON CONFLICT DO NOTHING;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND (OLD.parent_id IS DISTINCT FROM NEW.parent_id OR OLD.inherit_parent_acl IS DISTINCT FROM NEW.inherit_parent_acl) THEN
    WITH RECURSIVE sub AS (
      SELECT NEW.id AS id, ARRAY[NEW.id] AS seen
      UNION ALL
      SELECT c.id, sub.seen || c.id
      FROM nodes c
      JOIN sub ON c.parent_id = sub.id AND c.inherit_parent_acl
      WHERE NOT c.id = ANY(sub.seen)
    )
    SELECT array_agg(id ORDER BY id) INTO affected_ids FROM sub;

    PERFORM 1 FROM node_acl_state WHERE node_id = ANY(affected_ids) ORDER BY node_id FOR UPDATE;
    DELETE FROM node_acl_ancestors WHERE node_id = ANY(affected_ids);

    WITH RECURSIVE na AS (
      SELECT n.id AS node_id, n.id AS ancestor_id, n.parent_id, n.inherit_parent_acl, ARRAY[n.id] AS seen
      FROM nodes n
      WHERE n.id = ANY(affected_ids)
      UNION ALL
      SELECT na.node_id, p.id AS ancestor_id, p.parent_id, p.inherit_parent_acl, na.seen || p.id
      FROM na
      JOIN nodes p ON na.inherit_parent_acl AND p.id = na.parent_id
      WHERE NOT p.id = ANY(na.seen)
    )
    INSERT INTO node_acl_state (node_id, inherits_ws)
    SELECT node_id, COALESCE(bool_and(inherit_parent_acl), true)
    FROM na
    GROUP BY node_id
    ON CONFLICT (node_id) DO UPDATE SET inherits_ws = EXCLUDED.inherits_ws;

    WITH RECURSIVE na AS (
      SELECT n.id AS node_id, n.id AS ancestor_id, n.parent_id, n.inherit_parent_acl, ARRAY[n.id] AS seen
      FROM nodes n
      WHERE n.id = ANY(affected_ids)
      UNION ALL
      SELECT na.node_id, p.id AS ancestor_id, p.parent_id, p.inherit_parent_acl, na.seen || p.id
      FROM na
      JOIN nodes p ON na.inherit_parent_acl AND p.id = na.parent_id
      WHERE NOT p.id = ANY(na.seen)
    )
    INSERT INTO node_acl_ancestors (node_id, ancestor_id)
    SELECT node_id, ancestor_id FROM na
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER nodes_acl_closure_sync
AFTER INSERT OR DELETE OR UPDATE OF parent_id, inherit_parent_acl ON nodes
FOR EACH ROW EXECUTE FUNCTION sync_node_acl_closure();

-- Composite indexes for large-workspace listing & ACL lookups.
CREATE INDEX IF NOT EXISTS nodes_ws_active_updated_idx
  ON nodes (workspace_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS nodes_ws_parent_active_idx
  ON nodes (workspace_id, parent_id, personal, sort_key, id) WHERE deleted_at IS NULL AND wiki_space_id IS NULL;
CREATE INDEX IF NOT EXISTS doc_shares_user_doc_idx
  ON doc_shares (user_id, doc_id);
CREATE INDEX IF NOT EXISTS doc_link_joins_user_doc_idx
  ON doc_link_joins (user_id, doc_id);
CREATE INDEX IF NOT EXISTS org_dept_members_user_dept_idx
  ON org_department_members (user_id, department_id);
CREATE INDEX IF NOT EXISTS org_group_members_user_group_idx
  ON org_group_members (user_id, group_id);

-- External organization directory sync connectors and audit logs.
CREATE TABLE org_sync_sources (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  provider text NOT NULL CHECK (provider IN ('scim', 'ldap', 'wecom', 'dingtalk', 'custom')),
  enabled boolean NOT NULL DEFAULT true,
  token_hash text NOT NULL,
  token_prefix text NOT NULL DEFAULT '',
  auto_invite_missing boolean NOT NULL DEFAULT true,
  prune_missing boolean NOT NULL DEFAULT false,
  last_sync_at timestamptz,
  last_status text NOT NULL DEFAULT '',
  last_summary text NOT NULL DEFAULT '',
  created_by bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX org_sync_sources_ws_idx ON org_sync_sources (workspace_id, id);
CREATE UNIQUE INDEX org_sync_sources_token_hash_idx ON org_sync_sources (token_hash);

CREATE TABLE org_sync_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id bigint NOT NULL REFERENCES org_sync_sources(id) ON DELETE CASCADE,
  actor_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  trigger_mode text NOT NULL CHECK (trigger_mode IN ('manual', 'push', 'scim')),
  dry_run boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('ok', 'failed')),
  departments_created integer NOT NULL DEFAULT 0,
  departments_updated integer NOT NULL DEFAULT 0,
  departments_removed integer NOT NULL DEFAULT 0,
  groups_created integer NOT NULL DEFAULT 0,
  groups_updated integer NOT NULL DEFAULT 0,
  groups_removed integer NOT NULL DEFAULT 0,
  members_linked integer NOT NULL DEFAULT 0,
  members_invited integer NOT NULL DEFAULT 0,
  memberships_updated integer NOT NULL DEFAULT 0,
  error_message text NOT NULL DEFAULT '',
  details_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX org_sync_runs_ws_idx ON org_sync_runs (workspace_id, created_at DESC, id DESC);

ALTER TABLE org_departments
  ADD COLUMN sync_source_id bigint REFERENCES org_sync_sources(id) ON DELETE SET NULL,
  ADD COLUMN external_id text;
CREATE UNIQUE INDEX org_departments_sync_ext_idx
  ON org_departments (workspace_id, sync_source_id, external_id)
  WHERE sync_source_id IS NOT NULL AND external_id IS NOT NULL;

ALTER TABLE org_groups
  ADD COLUMN sync_source_id bigint REFERENCES org_sync_sources(id) ON DELETE SET NULL,
  ADD COLUMN external_id text;
CREATE UNIQUE INDEX org_groups_sync_ext_idx
  ON org_groups (workspace_id, sync_source_id, external_id)
  WHERE sync_source_id IS NOT NULL AND external_id IS NOT NULL;
