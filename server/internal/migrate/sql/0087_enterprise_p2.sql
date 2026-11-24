-- Route P2: Enterprise Open Platform & High-Compliance Auth
-- 1. Personal Access Tokens (PAT) for Bearer API authentication.
-- 2. Workspace Event Webhooks & delivery audit trail.
-- 3. TOTP / MFA enrollment, recovery codes, and short-lived login challenges.

CREATE TABLE IF NOT EXISTS personal_access_tokens (
    id           BIGSERIAL PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    token_prefix TEXT NOT NULL,
    token_hash   BYTEA NOT NULL UNIQUE,
    scopes       JSONB NOT NULL DEFAULT '["read","write"]'::jsonb,
    expires_at   TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pat_user ON personal_access_tokens(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS workspace_webhooks (
    id           BIGSERIAL PRIMARY KEY,
    workspace_id BIGINT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    url          TEXT NOT NULL,
    secret_enc   BYTEA,
    secret_hint  TEXT NOT NULL DEFAULT '',
    events       JSONB NOT NULL DEFAULT '[]'::jsonb,
    enabled      BOOLEAN NOT NULL DEFAULT true,
    created_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspace_webhooks_ws ON workspace_webhooks(workspace_id, id ASC);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id            BIGSERIAL PRIMARY KEY,
    webhook_id    BIGINT NOT NULL REFERENCES workspace_webhooks(id) ON DELETE CASCADE,
    workspace_id  BIGINT NOT NULL,
    event_type    TEXT NOT NULL,
    payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
    status_code   INT NOT NULL DEFAULT 0,
    response_body TEXT NOT NULL DEFAULT '',
    attempt       INT NOT NULL DEFAULT 1,
    success       BOOLEAN NOT NULL DEFAULT false,
    error_msg     TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_wh ON webhook_deliveries(webhook_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS user_mfa (
    user_id             BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret_enc          BYTEA NOT NULL,
    enabled             BOOLEAN NOT NULL DEFAULT false,
    recovery_codes_hash JSONB NOT NULL DEFAULT '[]'::jsonb,
    enabled_at          TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mfa_challenges (
    token_hash BYTEA PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mfa_challenges_exp ON mfa_challenges(expires_at);
