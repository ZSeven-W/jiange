-- A revision fence makes old and unattributed writers invalidate attribution,
-- even when multiple updates happen in the same transaction timestamp.
ALTER TABLE nodes ADD COLUMN modification_revision bigint NOT NULL DEFAULT 0 CHECK (modification_revision >= 0);

CREATE FUNCTION bump_node_modification_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.modification_revision := OLD.modification_revision + 1;
  RETURN NEW;
END;
$$;
CREATE TRIGGER nodes_modification_revision BEFORE UPDATE OF updated_at,title,parent_id,workspace_id,kind,creator_id,icon,cover_kind,cover_asset,cover_file_id,cover_position,deleted_at,trash_batch_id ON nodes
FOR EACH ROW EXECUTE FUNCTION bump_node_modification_revision();

CREATE TABLE document_last_modifier (
  doc_id bigint PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  modification_revision bigint NOT NULL
);

-- Older writers may append an operation without updating nodes.updated_at.
-- Remove prior attribution for every actual insert; modern writers restore
-- it later in the same transaction after committing the whole batch.
CREATE FUNCTION invalidate_document_modifier_on_op() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM document_last_modifier WHERE doc_id=NEW.doc_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER doc_ops_modifier_invalidation AFTER INSERT ON doc_ops
FOR EACH ROW EXECUTE FUNCTION invalidate_document_modifier_on_op();
