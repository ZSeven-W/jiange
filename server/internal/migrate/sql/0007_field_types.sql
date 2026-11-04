-- More bitable field types: multi-select, person, attachment and the computed
-- created_by / created_at / modified_at columns. Records learn who made them.
ALTER TABLE base_fields DROP CONSTRAINT base_fields_type_check;
ALTER TABLE base_fields ADD CONSTRAINT base_fields_type_check
    CHECK (type IN ('text', 'number', 'select', 'checkbox', 'date', 'multi_select', 'person', 'attachment', 'created_by', 'created_at', 'modified_at'));
ALTER TABLE base_records ADD COLUMN creator_id bigint REFERENCES users(id) ON DELETE SET NULL;
