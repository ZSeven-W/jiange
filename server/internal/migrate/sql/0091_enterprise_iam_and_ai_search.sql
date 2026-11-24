-- Wave 2: Enterprise IAM (SAML 2.0, Active Directory Pull, Org MFA Policy, WebAuthn/Passkeys)
-- and AI Hybrid Semantic Embeddings + Attachment Full-Text Indexing.

-- 1. SAML 2.0 SP fields on sso_providers
ALTER TABLE sso_providers
    ADD COLUMN IF NOT EXISTS saml_entity_id       TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS saml_sso_url         TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS saml_idp_cert_pem    TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS saml_sp_entity_id    TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS saml_attribute_email TEXT NOT NULL DEFAULT 'email',
    ADD COLUMN IF NOT EXISTS saml_attribute_name  TEXT NOT NULL DEFAULT 'displayName';

-- 2. Active Directory Pull connector config (LDAP / WeCom / DingTalk) on org_sync_sources
ALTER TABLE org_sync_sources
    ADD COLUMN IF NOT EXISTS endpoint_url          TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS connector_config_enc  BYTEA,
    ADD COLUMN IF NOT EXISTS connector_config_hint TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS sync_interval_minutes INTEGER NOT NULL DEFAULT 0 CHECK (sync_interval_minutes >= 0 AND sync_interval_minutes <= 10080),
    ADD COLUMN IF NOT EXISTS last_auto_sync_at     TIMESTAMPTZ;

ALTER TABLE org_sync_runs
    DROP CONSTRAINT IF EXISTS org_sync_runs_trigger_mode_check;
ALTER TABLE org_sync_runs
    ADD CONSTRAINT org_sync_runs_trigger_mode_check
    CHECK (trigger_mode IN ('manual', 'push', 'scim', 'pull', 'scheduled'));

-- 3. Workspace-level MFA enforcement toggle
ALTER TABLE workspace_security_policies
    ADD COLUMN IF NOT EXISTS require_mfa BOOLEAN NOT NULL DEFAULT false;

-- 4. WebAuthn / Passkeys credentials & short-lived challenges
CREATE TABLE IF NOT EXISTS user_passkeys (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id   BYTEA NOT NULL UNIQUE,
    public_key_cose BYTEA NOT NULL,
    sign_count      BIGINT NOT NULL DEFAULT 0,
    aaguid          TEXT NOT NULL DEFAULT '',
    transports      TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
    name            TEXT NOT NULL DEFAULT 'Passkey',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_user_passkeys_user ON user_passkeys(user_id);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
    challenge   TEXT PRIMARY KEY,
    user_id     BIGINT REFERENCES users(id) ON DELETE CASCADE,
    purpose     TEXT NOT NULL CHECK (purpose IN ('register', 'login')),
    rp_id       TEXT NOT NULL DEFAULT '',
    origin      TEXT NOT NULL DEFAULT '',
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_exp ON webauthn_challenges(expires_at);

-- 5. Hybrid semantic document embeddings (works on standard PostgreSQL 16 without custom extensions)
CREATE TABLE IF NOT EXISTS doc_embeddings (
    doc_id        BIGINT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
    workspace_id  BIGINT NOT NULL DEFAULT 0,
    model         TEXT NOT NULL DEFAULT 'local-ngram-v1',
    content_hash  TEXT NOT NULL DEFAULT '',
    dimensions    INTEGER NOT NULL DEFAULT 0,
    vector        REAL[] NOT NULL DEFAULT ARRAY[]::real[],
    excerpt       TEXT NOT NULL DEFAULT '',
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_doc_embeddings_ws ON doc_embeddings(workspace_id, updated_at DESC);

-- 6. Extracted attachment full-text index (PDF / DOCX / XLSX / PPTX / text / code)
CREATE TABLE IF NOT EXISTS attachment_text_index (
    attachment_id  BIGINT PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
    doc_id         BIGINT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    workspace_id   BIGINT NOT NULL DEFAULT 0,
    filename       TEXT NOT NULL DEFAULT '',
    mime           TEXT NOT NULL DEFAULT '',
    extracted_text TEXT NOT NULL DEFAULT '',
    extractor      TEXT NOT NULL DEFAULT '',
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attachment_text_doc ON attachment_text_index(doc_id);
CREATE INDEX IF NOT EXISTS idx_attachment_text_ws ON attachment_text_index(workspace_id);
