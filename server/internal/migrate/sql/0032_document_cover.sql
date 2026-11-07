-- A cover references either one shipped asset or an attachment owned by this
-- document. Application writes validate attachment ownership transactionally.
ALTER TABLE nodes ADD COLUMN cover_kind text NOT NULL DEFAULT 'none';
ALTER TABLE nodes ADD COLUMN cover_asset text NOT NULL DEFAULT '';
ALTER TABLE nodes ADD COLUMN cover_file_id bigint;
ALTER TABLE nodes ADD COLUMN cover_position double precision NOT NULL DEFAULT 0.5;
ALTER TABLE nodes ADD COLUMN cover_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE nodes ADD CONSTRAINT nodes_cover_shape_check CHECK (
  cover_position >= 0 AND cover_position <= 1 AND cover_revision >= 0 AND cover_revision <= 9007199254740991 AND
  ((cover_kind='none' AND cover_asset='' AND cover_file_id IS NULL) OR
   (cover_kind='builtin' AND cover_asset='misty-lake' AND cover_file_id IS NULL) OR
   (cover_kind='file' AND cover_asset='' AND cover_file_id IS NOT NULL AND cover_file_id > 0))
);

CREATE FUNCTION check_document_cover_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.kind='doc' AND NEW.cover_revision <> OLD.cover_revision + 1 THEN
    RAISE EXCEPTION 'document cover revision required' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_cover_revision_guard BEFORE UPDATE OF cover_kind,cover_asset,cover_file_id,cover_position ON nodes
FOR EACH ROW EXECUTE FUNCTION check_document_cover_revision();
