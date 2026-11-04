-- P5: per-option color index (into the preset palette) for select fields.
ALTER TABLE base_fields ADD COLUMN IF NOT EXISTS option_colors jsonb NOT NULL DEFAULT '[]';
