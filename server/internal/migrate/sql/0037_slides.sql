-- Slides: an independent presentation node kind with ordered pages.
-- Pages are plain (title + bullet body + background) in this first slice; the
-- collaborative rich-content model follows the table sub-CRDT integration.
ALTER TABLE nodes DROP CONSTRAINT nodes_kind_check;
ALTER TABLE nodes ADD CONSTRAINT nodes_kind_check CHECK (kind IN ('doc', 'base', 'folder', 'slides'));

CREATE TABLE slides_pages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slides_id bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  pos double precision NOT NULL,
  title text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  background text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slides_pages_pos_check CHECK (pos >= 0)
);
CREATE INDEX slides_pages_order ON slides_pages (slides_id, pos);
