-- File nodes are independent drive entries, with one immutable blob reference.
ALTER TABLE nodes DROP CONSTRAINT nodes_kind_check;
ALTER TABLE nodes ADD CONSTRAINT nodes_kind_check CHECK (kind IN ('doc', 'base', 'folder', 'slides', 'file'));
CREATE TABLE drive_files (
  node_id bigint PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  attachment_id bigint NOT NULL UNIQUE REFERENCES attachments(id) ON DELETE CASCADE
);

-- Files are leaves. Enforce this at the database so older servers cannot
-- attach document trees to an uploaded file while a rollout is in progress.
CREATE FUNCTION drive_reject_file_parent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_kind text;
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    PERFORM drive_lock_workspace(NEW.workspace_id);
    SELECT kind INTO parent_kind FROM nodes WHERE id=NEW.parent_id;
    IF parent_kind = 'file' THEN
      RAISE EXCEPTION 'file nodes cannot contain children' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER nodes_file_parent_guard BEFORE INSERT OR UPDATE OF parent_id, kind ON nodes
FOR EACH ROW EXECUTE FUNCTION drive_reject_file_parent();

-- Existing unversioned document mutations must not alter file entries.
CREATE FUNCTION drive_file_mutation_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.kind='file' THEN
    PERFORM drive_lock_workspace(OLD.workspace_id);
    IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.drive_revision <> OLD.drive_revision + 1 THEN
      RAISE EXCEPTION 'file mutation requires guarded drive operation' USING ERRCODE = '23514';
    END IF;
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND NEW.trash_batch_id IS NULL THEN
      RAISE EXCEPTION 'file trash requires batch' USING ERRCODE = '23514';
    END IF;
    IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL AND NEW.trash_batch_id IS NOT NULL THEN
      RAISE EXCEPTION 'file restore requires matching batch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER nodes_file_mutation_guard BEFORE UPDATE OF title, parent_id, kind, deleted_at, trash_batch_id ON nodes
FOR EACH ROW EXECUTE FUNCTION drive_file_mutation_fence();

-- A standalone file's blob reference is removed only with its node during
-- guarded purge. An older attachment endpoint must not break an active or
-- recoverable file by deleting just the referenced metadata row.
CREATE FUNCTION drive_file_attachment_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM drive_files f JOIN nodes n ON n.id=f.node_id WHERE f.attachment_id=OLD.id) THEN
    RAISE EXCEPTION 'drive file attachment requires node purge' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER attachments_drive_file_delete_guard BEFORE DELETE ON attachments
FOR EACH ROW EXECUTE FUNCTION drive_file_attachment_fence();
