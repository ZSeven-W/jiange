-- Hidden slides remain editable and shareable but are skipped in presentation.
ALTER TABLE slides_pages ADD COLUMN hidden boolean NOT NULL DEFAULT false;
