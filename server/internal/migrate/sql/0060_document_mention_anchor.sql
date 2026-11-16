-- Anchors are opaque collaboration IDs. Legacy notifications retain no anchor.
ALTER TABLE notifications ADD COLUMN anchor_block text NOT NULL DEFAULT '';
ALTER TABLE notifications ADD COLUMN anchor_char text NOT NULL DEFAULT '';
ALTER TABLE notifications ADD COLUMN anchor_epoch bigint NOT NULL DEFAULT 0;
