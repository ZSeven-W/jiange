-- Icon updates use their own revision to avoid overwriting concurrent changes.
ALTER TABLE nodes ADD COLUMN icon_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE nodes ADD CONSTRAINT nodes_icon_revision_check CHECK (icon_revision BETWEEN 0 AND 9007199254740991);

-- Prevent an old writer from silently overwriting an icon, including when it
-- assigns the same value. Old services must still be drained during rollout.
CREATE FUNCTION require_document_icon_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.kind = 'doc' AND NEW.kind = 'doc' AND NEW.icon_revision <> OLD.icon_revision + 1 THEN
    RAISE EXCEPTION 'document icon update requires a new revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER nodes_document_icon_revision
BEFORE UPDATE OF icon ON nodes
FOR EACH ROW EXECUTE FUNCTION require_document_icon_revision();
