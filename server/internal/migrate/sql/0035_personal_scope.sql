-- Personal scope (我的空间): membership alone grants nothing there; only the
-- creator and explicit shares apply — workspace owners/admins included. All
-- existing nodes stay in the shared scope, preserving historical grants
-- (不静默扩权或剥权). New personal nodes are created via the versioned drive
-- API; descendants inherit the scope from their parent folder.
ALTER TABLE nodes ADD COLUMN personal boolean NOT NULL DEFAULT false;
CREATE INDEX nodes_personal ON nodes (workspace_id, creator_id) WHERE personal;
