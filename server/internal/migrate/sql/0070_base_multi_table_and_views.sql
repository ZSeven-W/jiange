-- Multi-table Base support (scoping fields, records, and views to bt_tables)
-- plus personal views (bt_views.owner_id) and cross-table links (base_fields.target_table_id).

ALTER TABLE base_fields ADD COLUMN table_id bigint REFERENCES bt_tables(id) ON DELETE CASCADE;
ALTER TABLE base_fields ADD COLUMN target_table_id bigint REFERENCES bt_tables(id) ON DELETE SET NULL;
ALTER TABLE base_records ADD COLUMN table_id bigint REFERENCES bt_tables(id) ON DELETE CASCADE;
ALTER TABLE bt_views ADD COLUMN table_id bigint REFERENCES bt_tables(id) ON DELETE CASCADE;
ALTER TABLE bt_views ADD COLUMN owner_id bigint REFERENCES users(id) ON DELETE CASCADE;

-- Backfill every existing Base's fields, records, and views to its default bt_tables row.
UPDATE base_fields f
SET table_id = t.id
FROM bt_tables t
WHERE t.base_id = f.base_id AND t.is_default AND f.table_id IS NULL;

UPDATE base_records r
SET table_id = t.id
FROM bt_tables t
WHERE t.base_id = r.base_id AND t.is_default AND r.table_id IS NULL;

UPDATE bt_views v
SET table_id = t.id
FROM bt_tables t
WHERE t.base_id = v.base_id AND t.is_default AND v.table_id IS NULL;

ALTER TABLE base_fields ALTER COLUMN table_id SET NOT NULL;
ALTER TABLE base_records ALTER COLUMN table_id SET NOT NULL;
ALTER TABLE bt_views ALTER COLUMN table_id SET NOT NULL;

CREATE INDEX base_fields_table_idx ON base_fields (table_id, position, id);
CREATE INDEX base_records_table_idx ON base_records (table_id, position, id);
CREATE INDEX bt_views_table_idx ON bt_views (table_id, pos, id);
CREATE INDEX bt_views_owner_idx ON bt_views (base_id, table_id, owner_id) WHERE owner_id IS NOT NULL;

-- Scope the unique primary-field constraint per data table instead of per base.
DROP INDEX IF EXISTS base_fields_one_primary;
CREATE UNIQUE INDEX base_fields_one_primary ON base_fields (table_id) WHERE is_primary;

-- Update primary-field guard to also auto-fill default table_id on INSERT,
-- enforce table_id ownership, and allow primary-field deletion when the
-- owning data table itself is being deleted.
CREATE OR REPLACE FUNCTION base_field_primary_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    primary_id bigint;
    table_base bigint;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.table_id IS NULL THEN
            SELECT id INTO NEW.table_id
              FROM bt_tables WHERE base_id = NEW.base_id AND is_default LIMIT 1;
            IF NEW.table_id IS NULL THEN
                RAISE EXCEPTION 'base has no default table' USING ERRCODE = '23514';
            END IF;
        ELSE
            SELECT base_id INTO table_base FROM bt_tables WHERE id = NEW.table_id;
            IF table_base IS NULL OR table_base <> NEW.base_id THEN
                RAISE EXCEPTION 'field table does not belong to base' USING ERRCODE = '23514';
            END IF;
        END IF;

        SELECT id INTO primary_id
          FROM base_fields WHERE table_id = NEW.table_id AND is_primary;
        IF primary_id IS NULL THEN
            IF EXISTS (SELECT 1 FROM base_fields WHERE table_id = NEW.table_id) THEN
                RAISE EXCEPTION 'table has fields without a primary field' USING ERRCODE = '23514';
            END IF;
            NEW.is_primary := true;
        ELSIF NEW.is_primary THEN
            RAISE EXCEPTION 'primary field already exists' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        -- Deleting the owning table or base node cascades; deleting the primary alone may not.
        IF OLD.is_primary
           AND EXISTS (SELECT 1 FROM nodes WHERE id = OLD.base_id)
           AND EXISTS (SELECT 1 FROM bt_tables WHERE id = OLD.table_id) THEN
            RAISE EXCEPTION 'primary field cannot be deleted' USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
    END IF;
    IF NEW.base_id <> OLD.base_id OR NEW.table_id <> OLD.table_id OR NEW.is_primary <> OLD.is_primary THEN
        RAISE EXCEPTION 'primary field identity cannot be changed' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

-- Auto-fill default table_id on INSERT for base_records and bt_views so legacy
-- callers that omit table_id continue targeting the base's default table.
CREATE OR REPLACE FUNCTION base_default_table_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    table_base bigint;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.table_id IS NULL THEN
            SELECT id INTO NEW.table_id
              FROM bt_tables WHERE base_id = NEW.base_id AND is_default LIMIT 1;
            IF NEW.table_id IS NULL THEN
                RAISE EXCEPTION 'base has no default table' USING ERRCODE = '23514';
            END IF;
        ELSE
            SELECT base_id INTO table_base FROM bt_tables WHERE id = NEW.table_id;
            IF table_base IS NULL OR table_base <> NEW.base_id THEN
                RAISE EXCEPTION 'row table does not belong to base' USING ERRCODE = '23514';
            END IF;
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.base_id <> OLD.base_id OR NEW.table_id <> OLD.table_id THEN
        RAISE EXCEPTION 'table_id cannot be changed' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER base_records_table_guard
    BEFORE INSERT OR UPDATE ON base_records
    FOR EACH ROW EXECUTE FUNCTION base_default_table_guard();

CREATE TRIGGER bt_views_table_guard
    BEFORE INSERT OR UPDATE ON bt_views
    FOR EACH ROW EXECUTE FUNCTION base_default_table_guard();
