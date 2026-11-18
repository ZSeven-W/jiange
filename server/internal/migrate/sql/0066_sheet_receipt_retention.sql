-- Expired spreadsheet idempotency receipts are pruned on each write to the
-- same workbook; this index keeps that delete a short range scan.
CREATE INDEX sheet_write_receipts_expiry ON sheet_write_receipts (node_id, created_at);
