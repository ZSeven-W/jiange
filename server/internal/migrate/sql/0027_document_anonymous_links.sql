-- Anonymous document links are a supported sharing mode.
ALTER TABLE nodes DROP CONSTRAINT nodes_link_role_check;
ALTER TABLE nodes ADD CONSTRAINT nodes_link_role_check CHECK (link_role IN ('none', 'anon', 'view', 'edit'));
