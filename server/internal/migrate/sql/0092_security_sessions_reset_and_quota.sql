-- Wave 4: Session metadata/revocation, password reset tokens, and workspace storage quota.

-- 1. Session metadata & non-secret numeric ID for active-session management
ALTER TABLE sessions
    ADD COLUMN IF NOT EXISTS id           BIGSERIAL UNIQUE,
    ADD COLUMN IF NOT EXISTS user_agent   TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS ip_address   TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- 2. Single-use time-limited password reset tokens (SHA-256 hash stored, plaintext sent via email)
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token_hash BYTEA PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_exp ON password_reset_tokens(expires_at);

-- 3. Per-workspace attachment storage quota (0 = unlimited)
ALTER TABLE workspace_security_policies
    ADD COLUMN IF NOT EXISTS storage_quota_bytes BIGINT NOT NULL DEFAULT 0 CHECK (storage_quota_bytes >= 0);
