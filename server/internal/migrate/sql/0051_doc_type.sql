-- Document subtype: a "board" (画板) is a document containing only a whiteboard
-- block. It stays kind='doc' for access, sharing, sync and copy; lists use the
-- subtype for the icon and the type filter (Feishu shows 画板 as its own type).
ALTER TABLE nodes ADD COLUMN doc_type text NOT NULL DEFAULT '';
ALTER TABLE nodes ADD CONSTRAINT nodes_doc_type_check CHECK (doc_type IN ('', 'board') AND (doc_type = '' OR kind = 'doc'));
