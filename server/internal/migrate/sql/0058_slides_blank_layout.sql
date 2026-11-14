ALTER TABLE slides_pages DROP CONSTRAINT slides_pages_layout_check;
ALTER TABLE slides_pages ADD CONSTRAINT slides_pages_layout_check CHECK (layout IN ('', 'title', 'blank', 'blank-title'));
