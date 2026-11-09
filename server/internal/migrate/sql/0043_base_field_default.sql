-- Feishu 默认值: a field-level default applied to cells omitted when a record is created.
ALTER TABLE base_fields ADD COLUMN default_value jsonb;
