-- Prevent concurrent slide text edits from silently overwriting each other.
ALTER TABLE slides_pages ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0);
