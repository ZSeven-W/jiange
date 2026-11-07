-- Preserve existing restrictions while separating content copying from
-- creating copies, printing and downloading.
ALTER TABLE nodes ADD COLUMN copy_min_role text NOT NULL DEFAULT 'view';
ALTER TABLE nodes ADD COLUMN download_min_role text NOT NULL DEFAULT 'view';
ALTER TABLE nodes ADD COLUMN permissions_revision bigint NOT NULL DEFAULT 0;

UPDATE nodes SET copy_min_role = CASE WHEN copy_protected THEN 'manage' ELSE 'view' END,
                 download_min_role = CASE WHEN copy_protected THEN 'manage' ELSE 'view' END;

ALTER TABLE nodes ADD CONSTRAINT nodes_copy_min_role_check CHECK (copy_min_role IN ('view','edit','manage'));
ALTER TABLE nodes ADD CONSTRAINT nodes_download_min_role_check CHECK (download_min_role IN ('view','edit','manage'));
ALTER TABLE nodes ADD CONSTRAINT nodes_permissions_revision_check CHECK (permissions_revision BETWEEN 0 AND 9007199254740991);
-- Reject a stale binary even when it assigns the same old boolean. PostgreSQL
-- UPDATE OF observes the target list, not just whether values changed. New
-- writers must update policy and revision in the same statement. This does not
-- gate old readers, which still require old services to be drained on rollout.
CREATE FUNCTION require_document_permission_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.kind = 'doc' AND NEW.kind = 'doc' AND NEW.permissions_revision <> OLD.permissions_revision + 1 THEN
    RAISE EXCEPTION 'document permission update requires a new revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER nodes_document_permission_revision
BEFORE UPDATE OF copy_protected, copy_min_role, download_min_role ON nodes
FOR EACH ROW EXECUTE FUNCTION require_document_permission_revision();

-- A compatibility boolean is intentionally conservative. Base retains its
-- old independent flag semantics.
ALTER TABLE nodes ADD CONSTRAINT nodes_document_copy_projection_check CHECK (
  kind <> 'doc' OR copy_protected = (copy_min_role <> 'view' OR download_min_role <> 'view')
);
