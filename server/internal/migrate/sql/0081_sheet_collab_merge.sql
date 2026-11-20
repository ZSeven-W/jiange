-- Per-field cell revision tracking for fine-grained concurrent cell merging
-- (e.g. orthogonal value vs. formatting edits on the same cell converge cleanly
-- without rejecting either collaborator's write).
ALTER TABLE sheet_cells
  ADD COLUMN IF NOT EXISTS field_revs jsonb NOT NULL DEFAULT '{}'::jsonb;
