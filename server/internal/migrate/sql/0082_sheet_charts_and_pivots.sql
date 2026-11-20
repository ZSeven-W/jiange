-- Embedded spreadsheet charts and persisted pivot table definitions per worksheet.
ALTER TABLE sheet_worksheets
  ADD COLUMN IF NOT EXISTS charts jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS pivot_tables jsonb NOT NULL DEFAULT '[]'::jsonb;
