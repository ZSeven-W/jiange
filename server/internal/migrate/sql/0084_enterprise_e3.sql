-- Route E3: Enterprise Delivery Foundation
-- 1. OIDC / OAuth2 SSO providers, linked external identities, and short-lived PKCE/CSRF auth states.
-- 2. Enterprise security audit logs.
-- 3. Workspace-wide security policy (unified document/sheet/base/slides watermark).

CREATE TABLE IF NOT EXISTS sso_providers (
    id                BIGSERIAL PRIMARY KEY,
    workspace_id      BIGINT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    slug              TEXT NOT NULL UNIQUE,
    name              TEXT NOT NULL,
    provider_type     TEXT NOT NULL DEFAULT 'oidc',
    enabled           BOOLEAN NOT NULL DEFAULT true,
    issuer_url        TEXT NOT NULL DEFAULT '',
    auth_url          TEXT NOT NULL,
    token_url         TEXT NOT NULL,
    userinfo_url      TEXT NOT NULL DEFAULT '',
    client_id         TEXT NOT NULL,
    client_secret_enc BYTEA,
    secret_hint       TEXT NOT NULL DEFAULT '',
    scopes            TEXT NOT NULL DEFAULT 'openid email profile',
    auto_create_user  BOOLEAN NOT NULL DEFAULT true,
    default_role      TEXT NOT NULL DEFAULT 'member',
    allowed_domains   TEXT NOT NULL DEFAULT '',
    created_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sso_providers_ws ON sso_providers(workspace_id);

CREATE TABLE IF NOT EXISTS sso_identities (
    provider_id   BIGINT NOT NULL REFERENCES sso_providers(id) ON DELETE CASCADE,
    subject       TEXT NOT NULL,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email         TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (provider_id, subject)
);

CREATE INDEX IF NOT EXISTS idx_sso_identities_user ON sso_identities(user_id);

CREATE TABLE IF NOT EXISTS sso_auth_states (
    state         TEXT PRIMARY KEY,
    provider_id   BIGINT NOT NULL REFERENCES sso_providers(id) ON DELETE CASCADE,
    code_verifier TEXT NOT NULL,
    nonce         TEXT NOT NULL,
    redirect_to   TEXT NOT NULL DEFAULT '',
    expires_at    TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sso_auth_states_exp ON sso_auth_states(expires_at);

CREATE TABLE IF NOT EXISTS audit_logs (
    id             BIGSERIAL PRIMARY KEY,
    workspace_id   BIGINT NOT NULL DEFAULT 0,
    actor_id       BIGINT REFERENCES users(id) ON DELETE SET NULL,
    actor_name     TEXT NOT NULL DEFAULT '',
    actor_email    TEXT NOT NULL DEFAULT '',
    action         TEXT NOT NULL,
    resource_type  TEXT NOT NULL DEFAULT '',
    resource_id    BIGINT NOT NULL DEFAULT 0,
    resource_title TEXT NOT NULL DEFAULT '',
    detail         JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address     TEXT NOT NULL DEFAULT '',
    user_agent     TEXT NOT NULL DEFAULT '',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_ws_time ON audit_logs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_time ON audit_logs(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_time ON audit_logs(action, created_at DESC);

CREATE TABLE IF NOT EXISTS workspace_security_policies (
    workspace_id         BIGINT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    watermark_enabled    BOOLEAN NOT NULL DEFAULT false,
    watermark_text       TEXT NOT NULL DEFAULT '',
    watermark_show_user  BOOLEAN NOT NULL DEFAULT true,
    watermark_show_email BOOLEAN NOT NULL DEFAULT true,
    watermark_show_date  BOOLEAN NOT NULL DEFAULT true,
    watermark_opacity    DOUBLE PRECISION NOT NULL DEFAULT 0.07,
    updated_by           BIGINT REFERENCES users(id) ON DELETE SET NULL,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
