-- Bitable v2: record links behind link fields (one-way; two-way is rendered
-- by querying the same table in reverse). Field type 'lookup' reads through
-- a link field without storing anything.
CREATE TABLE bt_links (
    id          bigserial PRIMARY KEY,
    base_id     bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    field_id    bigint NOT NULL REFERENCES base_fields(id) ON DELETE CASCADE,
    from_record bigint NOT NULL REFERENCES base_records(id) ON DELETE CASCADE,
    to_record   bigint NOT NULL REFERENCES base_records(id) ON DELETE CASCADE,
    UNIQUE (field_id, from_record, to_record)
);
CREATE INDEX bt_links_from ON bt_links (from_record, field_id);
ALTER TABLE base_fields DROP CONSTRAINT base_fields_type_check;
ALTER TABLE base_fields ADD CONSTRAINT base_fields_type_check
    CHECK (type IN ('text', 'number', 'select', 'checkbox', 'date', 'multi_select', 'person', 'attachment',
                    'created_by', 'created_at', 'modified_at', 'url', 'phone', 'email', 'rating', 'formula',
                    'link', 'lookup'));
