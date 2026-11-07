-- Folder nodes are exposed only by the versioned drive API. Legacy clients
-- must not interpret them as documents, and old server processes must be
-- drained before this migration is used in production.
ALTER TABLE nodes DROP CONSTRAINT nodes_kind_check;
ALTER TABLE nodes ADD CONSTRAINT nodes_kind_check CHECK (kind IN ('doc', 'base', 'folder'));

ALTER TABLE nodes ADD COLUMN drive_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE nodes ADD COLUMN trash_batch_id bigint;
ALTER TABLE nodes ADD CONSTRAINT nodes_drive_revision_check CHECK (drive_revision BETWEEN 0 AND 9007199254740991);
ALTER TABLE nodes ADD CONSTRAINT nodes_trash_batch_shape_check CHECK (
  trash_batch_id IS NULL OR (trash_batch_id > 0 AND deleted_at IS NOT NULL)
);
CREATE SEQUENCE drive_trash_batch_seq AS bigint MINVALUE 1;
CREATE INDEX nodes_drive_trash_batch ON nodes (workspace_id, trash_batch_id) WHERE trash_batch_id IS NOT NULL;

-- All guarded drive mutations must acquire this lock in a separate SQL
-- statement *before* reading or locking nodes. A row trigger also takes it
-- to make legacy structural statements contend with guarded operations.
-- The trigger lock alone is not enough: an UPDATE statement may have taken
-- its READ COMMITTED snapshot before waiting for the advisory lock.
CREATE FUNCTION drive_lock_workspace(p_workspace_id bigint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_workspace_id IS NULL OR p_workspace_id <= 0 THEN
    RAISE EXCEPTION 'invalid drive workspace' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('jiange:drive:' || p_workspace_id::text, 0));
END;
$$;

-- Check the parent chain without recursion that can loop forever on corrupt
-- historical data. Guarded callers hold the workspace advisory lock before
-- this query; old writers are fenced by drive_revision below.
CREATE FUNCTION drive_parent_chain(p_start bigint, p_workspace bigint, p_forbidden bigint, p_active boolean)
RETURNS TABLE(has_folder boolean, invalid boolean) LANGUAGE plpgsql AS $$
DECLARE
  cur bigint := p_start;
  visited bigint[] := ARRAY[]::bigint[];
  next_parent bigint;
  actual_workspace bigint;
  node_kind text;
  removed timestamptz;
BEGIN
  has_folder := false;
  invalid := false;
  WHILE cur IS NOT NULL LOOP
    IF cur = p_forbidden OR cur = ANY(visited) OR cardinality(visited) >= 4096 THEN
      invalid := true;
      RETURN NEXT;
      RETURN;
    END IF;
    visited := array_append(visited, cur);
    SELECT parent_id, workspace_id, kind, deleted_at
      INTO next_parent, actual_workspace, node_kind, removed FROM nodes WHERE id=cur;
    IF NOT FOUND OR actual_workspace <> p_workspace OR (p_active AND removed IS NOT NULL) THEN
      invalid := true;
      RETURN NEXT;
      RETURN;
    END IF;
    has_folder := has_folder OR node_kind='folder';
    cur := next_parent;
  END LOOP;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION fence_drive_node_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_folder boolean := false;
  invalid_chain boolean := false;
  direct_parent_kind text;
BEGIN
  PERFORM drive_lock_workspace(NEW.workspace_id);
  IF NEW.parent_id IS NOT NULL THEN
    SELECT has_folder, invalid INTO parent_folder, invalid_chain
      FROM drive_parent_chain(NEW.parent_id, NEW.workspace_id, NEW.id, true);
  END IF;
  IF NEW.kind='folder' OR parent_folder THEN
    IF invalid_chain OR NEW.drive_revision <> 1 OR NEW.deleted_at IS NOT NULL OR NEW.trash_batch_id IS NOT NULL THEN
      RAISE EXCEPTION 'folder insert requires guarded drive operation' USING ERRCODE = '23514';
    END IF;
    IF NEW.kind='folder' AND NEW.parent_id IS NOT NULL THEN
      SELECT kind INTO direct_parent_kind FROM nodes WHERE id=NEW.parent_id;
      IF direct_parent_kind IS DISTINCT FROM 'folder' THEN
        RAISE EXCEPTION 'folder parent must be a folder' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER nodes_drive_insert_fence BEFORE INSERT ON nodes
FOR EACH ROW EXECUTE FUNCTION fence_drive_node_insert();

CREATE FUNCTION fence_drive_node_parent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_folder boolean := false;
  new_folder boolean := false;
  old_invalid boolean := false;
  new_invalid boolean := false;
  direct_parent_kind text;
BEGIN
  -- Workspace moves involving folders are rejected below, so one lock is
  -- enough for valid drive operations. Two distinct workspace IDs are locked
  -- in numeric order for legacy non-drive updates to avoid lock inversion.
  IF OLD.workspace_id <= NEW.workspace_id THEN
    PERFORM drive_lock_workspace(OLD.workspace_id);
    IF OLD.workspace_id <> NEW.workspace_id THEN PERFORM drive_lock_workspace(NEW.workspace_id); END IF;
  ELSE
    PERFORM drive_lock_workspace(NEW.workspace_id);
    PERFORM drive_lock_workspace(OLD.workspace_id);
  END IF;
  IF OLD.kind='folder' OR NEW.kind='folder' THEN
    old_folder := true;
    new_folder := true;
  END IF;
  IF OLD.parent_id IS NOT NULL THEN
    SELECT has_folder, invalid INTO old_folder, old_invalid
      FROM drive_parent_chain(OLD.parent_id, OLD.workspace_id, OLD.id, false);
    old_folder := old_folder OR OLD.kind='folder';
  END IF;
  IF NEW.parent_id IS NOT NULL THEN
    SELECT has_folder, invalid INTO new_folder, new_invalid
      FROM drive_parent_chain(NEW.parent_id, NEW.workspace_id, NEW.id, true);
    new_folder := new_folder OR NEW.kind='folder';
  END IF;
  IF old_folder OR new_folder THEN
    IF OLD.kind IS DISTINCT FROM NEW.kind OR OLD.workspace_id <> NEW.workspace_id OR
       old_invalid OR new_invalid OR NEW.drive_revision <> OLD.drive_revision + 1 THEN
      RAISE EXCEPTION 'folder move requires guarded drive operation' USING ERRCODE = '23514';
    END IF;
    IF NEW.kind='folder' AND NEW.parent_id IS NOT NULL THEN
      SELECT kind INTO direct_parent_kind FROM nodes WHERE id=NEW.parent_id;
      IF direct_parent_kind IS DISTINCT FROM 'folder' THEN
        RAISE EXCEPTION 'folder parent must be a folder' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER nodes_drive_parent_fence BEFORE UPDATE OF parent_id, workspace_id, kind ON nodes
FOR EACH ROW EXECUTE FUNCTION fence_drive_node_parent();

CREATE FUNCTION fence_drive_node_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_folder boolean := false;
  invalid_chain boolean := false;
BEGIN
  PERFORM drive_lock_workspace(OLD.workspace_id);
  IF OLD.parent_id IS NOT NULL THEN
    SELECT has_folder, invalid INTO parent_folder, invalid_chain
      FROM drive_parent_chain(OLD.parent_id, OLD.workspace_id, OLD.id, false);
  END IF;
  IF OLD.kind='folder' OR parent_folder THEN
    IF invalid_chain OR NEW.drive_revision <> OLD.drive_revision + 1 THEN
      RAISE EXCEPTION 'folder trash requires guarded drive operation' USING ERRCODE = '23514';
    END IF;
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND NEW.trash_batch_id IS NULL THEN
      RAISE EXCEPTION 'folder trash requires batch' USING ERRCODE = '23514';
    END IF;
    IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL AND
       (OLD.trash_batch_id IS NULL OR NEW.trash_batch_id IS NOT NULL) THEN
      RAISE EXCEPTION 'folder restore requires matching batch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER nodes_drive_deleted_fence BEFORE UPDATE OF deleted_at, trash_batch_id ON nodes
FOR EACH ROW EXECUTE FUNCTION fence_drive_node_deleted();

CREATE FUNCTION fence_drive_folder_title() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.kind='folder' THEN
    PERFORM drive_lock_workspace(OLD.workspace_id);
    IF NEW.drive_revision <> OLD.drive_revision + 1 THEN
      RAISE EXCEPTION 'folder rename requires guarded drive operation' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER nodes_drive_title_fence BEFORE UPDATE OF title ON nodes
FOR EACH ROW EXECUTE FUNCTION fence_drive_folder_title();
