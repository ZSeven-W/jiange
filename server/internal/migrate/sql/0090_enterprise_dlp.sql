-- Final Polish: Enterprise DLP (Data Loss Prevention) & Data Retention Policy.

ALTER TABLE workspace_security_policies
    ADD COLUMN IF NOT EXISTS dlp_enabled BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS dlp_keywords TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
    ADD COLUMN IF NOT EXISTS dlp_action TEXT NOT NULL DEFAULT 'warn' CHECK (dlp_action IN ('warn', 'block')),
    ADD COLUMN IF NOT EXISTS dlp_block_public_share BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS retention_days INTEGER NOT NULL DEFAULT 0 CHECK (retention_days >= 0 AND retention_days <= 3650);
