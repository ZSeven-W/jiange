-- 人员字段允许多选: a person field may hold a JSON array of member ids.
ALTER TABLE base_fields ADD COLUMN multiple boolean NOT NULL DEFAULT false;
