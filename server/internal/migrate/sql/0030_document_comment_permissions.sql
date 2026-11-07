-- Preserve existing editing-only comment access while new documents default to view.
ALTER TABLE nodes ADD COLUMN comment_min_role text NOT NULL DEFAULT 'edit';
ALTER TABLE nodes ALTER COLUMN comment_min_role SET DEFAULT 'view';
ALTER TABLE nodes ADD CONSTRAINT nodes_comment_min_role_check CHECK (comment_min_role IN ('view','edit'));
-- Existing policy updates already advance permissions_revision in the same transaction.
CREATE TRIGGER nodes_document_comment_permission_revision
BEFORE UPDATE OF comment_min_role ON nodes
FOR EACH ROW EXECUTE FUNCTION require_document_permission_revision();
