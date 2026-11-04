-- Bitable v2: formula fields. The expression is stored per field and
-- evaluated client-side (dependency graph); the server validates syntax and
-- references via btformula.
ALTER TABLE base_fields ADD COLUMN IF NOT EXISTS formula text NOT NULL DEFAULT '';
