-- Docs v2: copy/download protection flag (watermark + copy restrictions for
-- non-manage collaborators).
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS copy_protected bool NOT NULL DEFAULT false;
