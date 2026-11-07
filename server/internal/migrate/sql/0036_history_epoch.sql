-- History epoch (P0.4): after a database restore/PITR the op log can rewind
-- to the same head with different content; comparing seq numbers alone cannot
-- detect that. The epoch is an independent generation of the log: operators
-- bump it for affected docs after a rollback
--   UPDATE doc_heads SET history_epoch = history_epoch + 1 WHERE doc_id IN (...);
-- v2 sync clients cache (epoch, seq); a changed epoch forces a full snapshot
-- resync while their unacknowledged drafts are retried through the existing
-- operation-identity dedup.
ALTER TABLE doc_heads ADD COLUMN history_epoch bigint NOT NULL DEFAULT 1;
ALTER TABLE doc_heads ADD CONSTRAINT doc_heads_history_epoch_check CHECK (history_epoch >= 1);
