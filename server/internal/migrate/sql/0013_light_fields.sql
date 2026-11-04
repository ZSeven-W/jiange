-- Docs/bitable v2: light field types (url, phone, email, rating) + field description.
ALTER TABLE base_fields DROP CONSTRAINT base_fields_type_check;
ALTER TABLE base_fields ADD CONSTRAINT base_fields_type_check
    CHECK (type IN ('text', 'number', 'select', 'checkbox', 'date', 'multi_select', 'person', 'attachment',
                    'created_by', 'created_at', 'modified_at', 'url', 'phone', 'email', 'rating'));
ALTER TABLE base_fields ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
