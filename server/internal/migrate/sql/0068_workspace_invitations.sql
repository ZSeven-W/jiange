-- Joining a workspace requires the invitee's consent. Invitations are keyed
-- by lower-cased email so the inviter learns nothing about whether an account
-- exists; the invitee accepts or declines after signing in.
CREATE TABLE workspace_invitations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 320 AND email = lower(email)),
  role text NOT NULL CHECK (role IN ('member', 'admin')),
  inviter_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, email)
);
CREATE INDEX workspace_invitations_email_idx ON workspace_invitations (email);
