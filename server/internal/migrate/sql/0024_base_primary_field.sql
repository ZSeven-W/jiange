-- Preserve the existing record-title choice: the first text field, or the
-- current first field when no text field exists. Do not reorder legacy fields.
-- Empty bases remain empty; their first subsequently created field becomes primary.
ALTER TABLE base_fields ADD COLUMN is_primary boolean NOT NULL DEFAULT false;

WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY base_id ORDER BY CASE WHEN type = 'text' THEN 0 ELSE 1 END, position, id) AS n
    FROM base_fields
)
UPDATE base_fields AS field SET is_primary = true
FROM ranked WHERE field.id = ranked.id AND ranked.n = 1;

CREATE UNIQUE INDEX base_fields_one_primary ON base_fields (base_id) WHERE is_primary;

-- Older server versions do not send is_primary. Protect durable identity and
-- deletion at the database boundary; old servers may still reorder columns.
CREATE FUNCTION base_field_primary_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    primary_id bigint;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT id INTO primary_id
          FROM base_fields WHERE base_id = NEW.base_id AND is_primary;
        IF primary_id IS NULL THEN
            IF EXISTS (SELECT 1 FROM base_fields WHERE base_id = NEW.base_id) THEN
                RAISE EXCEPTION 'base has fields without a primary field' USING ERRCODE = '23514';
            END IF;
            NEW.is_primary := true;
        ELSIF NEW.is_primary THEN
            RAISE EXCEPTION 'primary field already exists' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        -- A node deletion may cascade; deleting its primary alone may not.
        IF OLD.is_primary AND EXISTS (SELECT 1 FROM nodes WHERE id = OLD.base_id) THEN
            RAISE EXCEPTION 'primary field cannot be deleted' USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
    END IF;
    IF NEW.base_id <> OLD.base_id OR NEW.is_primary <> OLD.is_primary THEN
        RAISE EXCEPTION 'primary field identity cannot be changed' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER base_field_primary_guard_trigger
    BEFORE INSERT OR UPDATE OR DELETE ON base_fields
    FOR EACH ROW EXECUTE FUNCTION base_field_primary_guard();
