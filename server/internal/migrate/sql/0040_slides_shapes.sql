ALTER TABLE slides_pages ADD COLUMN shapes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(shapes) = 'array');
