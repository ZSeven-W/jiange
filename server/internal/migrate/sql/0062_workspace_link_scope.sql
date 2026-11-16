-- Workspace links require current membership, checked when joining and reading.
ALTER TABLE nodes DROP CONSTRAINT nodes_link_role_check;
ALTER TABLE nodes ADD CONSTRAINT nodes_link_role_check CHECK
  (link_role IN ('none','anon','view','edit','workspace_view','workspace_edit'));

-- Crossing the workspace-only boundary must rotate the token. This prevents
-- a join recorded by an old server from becoming a grant under a later scope.
CREATE FUNCTION require_workspace_link_rotation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.link_role <> 'none' AND NEW.link_role <> 'none'
     AND (OLD.link_role IN ('workspace_view','workspace_edit')) <> (NEW.link_role IN ('workspace_view','workspace_edit'))
     AND OLD.link_token IS NOT DISTINCT FROM NEW.link_token THEN
    RAISE EXCEPTION 'workspace link scope change requires token rotation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER nodes_workspace_link_rotation BEFORE UPDATE OF link_role,link_token ON nodes
FOR EACH ROW EXECUTE FUNCTION require_workspace_link_rotation();
