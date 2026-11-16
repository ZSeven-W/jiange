-- All writers, including older server binaries, advance this fence when the
-- link role or token changes. New guarded clients can reject stale actions.
ALTER TABLE nodes ADD COLUMN link_revision bigint NOT NULL DEFAULT 0
    CHECK (link_revision BETWEEN 0 AND 9007199254740991);
CREATE FUNCTION advance_link_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.link_role IS DISTINCT FROM OLD.link_role OR NEW.link_token IS DISTINCT FROM OLD.link_token THEN
    IF OLD.link_revision >= 9007199254740991 THEN
      RAISE EXCEPTION 'link revision exhausted' USING ERRCODE = '23514';
    END IF;
    NEW.link_revision := OLD.link_revision + 1;
  ELSE
    NEW.link_revision := OLD.link_revision;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER nodes_link_revision BEFORE UPDATE ON nodes
FOR EACH ROW EXECUTE FUNCTION advance_link_revision();
