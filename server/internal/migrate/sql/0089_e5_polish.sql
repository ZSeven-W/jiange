-- Route E5: Final Polish Wave — External Notification Channels (SMTP / Feishu / DingTalk / WeCom / Slack).

CREATE TABLE IF NOT EXISTS workspace_notification_channels (
    id           BIGSERIAL PRIMARY KEY,
    workspace_id BIGINT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name         TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
    kind         TEXT NOT NULL CHECK (kind IN ('smtp', 'feishu_bot', 'dingtalk_bot', 'wecom_bot', 'slack_bot')),
    config_enc   BYTEA NOT NULL,
    config_hint  TEXT NOT NULL DEFAULT '',
    events       TEXT[] NOT NULL DEFAULT ARRAY['mention', 'comment_reply', 'automation']::text[],
    enabled      BOOLEAN NOT NULL DEFAULT true,
    last_status  TEXT NOT NULL DEFAULT '',
    last_error   TEXT NOT NULL DEFAULT '',
    last_sent_at TIMESTAMPTZ,
    created_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ws_notif_channels_ws
    ON workspace_notification_channels(workspace_id, created_at DESC, id DESC);

-- Route E5-4: Allow explicit CrossSpaceMoveNode transactions to move folder subtrees across
-- workspaces while keeping strict fencing intact for legacy/unguarded SQL updates.
CREATE OR REPLACE FUNCTION fence_drive_node_parent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_folder boolean := false;
  new_folder boolean := false;
  old_invalid boolean := false;
  new_invalid boolean := false;
  allow_cross boolean := current_setting('jiange.allow_cross_workspace_move', true) = 'on';
  direct_parent_kind text;
BEGIN
  IF OLD.workspace_id <= NEW.workspace_id THEN
    PERFORM drive_lock_workspace(OLD.workspace_id);
    IF OLD.workspace_id <> NEW.workspace_id THEN PERFORM drive_lock_workspace(NEW.workspace_id); END IF;
  ELSE
    PERFORM drive_lock_workspace(NEW.workspace_id);
    PERFORM drive_lock_workspace(OLD.workspace_id);
  END IF;
  IF OLD.kind='folder' OR NEW.kind='folder' THEN
    old_folder := true;
    new_folder := true;
  END IF;
  IF OLD.parent_id IS NOT NULL THEN
    SELECT has_folder, invalid INTO old_folder, old_invalid
      FROM drive_parent_chain(OLD.parent_id, OLD.workspace_id, OLD.id, false);
    old_folder := old_folder OR OLD.kind='folder';
  END IF;
  IF NEW.parent_id IS NOT NULL THEN
    SELECT has_folder, invalid INTO new_folder, new_invalid
      FROM drive_parent_chain(NEW.parent_id, NEW.workspace_id, NEW.id, true);
    new_folder := new_folder OR NEW.kind='folder';
  END IF;
  IF old_folder OR new_folder THEN
    IF OLD.kind IS DISTINCT FROM NEW.kind OR
       (OLD.workspace_id <> NEW.workspace_id AND NOT allow_cross) OR
       (old_invalid AND NOT (allow_cross AND OLD.workspace_id <> NEW.workspace_id)) OR
       new_invalid OR
       NEW.drive_revision <> OLD.drive_revision + 1 THEN
      RAISE EXCEPTION 'folder move requires guarded drive operation' USING ERRCODE = '23514';
    END IF;
    IF NEW.kind='folder' AND NEW.parent_id IS NOT NULL THEN
      SELECT kind INTO direct_parent_kind FROM nodes WHERE id=NEW.parent_id;
      IF direct_parent_kind IS DISTINCT FROM 'folder' THEN
        RAISE EXCEPTION 'folder parent must be a folder' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
