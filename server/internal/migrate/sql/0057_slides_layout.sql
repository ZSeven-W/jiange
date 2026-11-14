-- Layout is independent of the page's text and survives older writes.
ALTER TABLE slides_pages ADD COLUMN layout text NOT NULL DEFAULT '' CHECK (layout IN ('', 'title'));
