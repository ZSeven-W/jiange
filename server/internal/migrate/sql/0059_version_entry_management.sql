-- Keep deleted entries as tombstones: otherwise legacy snapshot fallback would
-- make the deleted version visible again, and create retries could resurrect it.
ALTER TABLE doc_version_entries ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0);
ALTER TABLE doc_version_entries ADD COLUMN deleted_at timestamptz;
-- Legacy s:<seq> links remain stable when their snapshot is promoted to a row.
ALTER TABLE doc_version_entries ADD COLUMN legacy_seq boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX doc_version_entries_legacy_seq ON doc_version_entries(doc_id, seq) WHERE legacy_seq;
