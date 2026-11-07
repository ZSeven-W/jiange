-- Establish the durable identity of the existing data table without moving
-- fields, records, views, links or public-form references.  A future release
-- may add other tables only after table-scoped storage and a mixed-version
-- deployment gate are complete.
CREATE TABLE bt_tables (
    id          bigserial PRIMARY KEY,
    base_id     bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
    position    double precision NOT NULL DEFAULT 1,
    is_default  boolean NOT NULL DEFAULT true
);

CREATE UNIQUE INDEX bt_tables_one_default ON bt_tables (base_id) WHERE is_default;

INSERT INTO bt_tables (base_id, name, position, is_default)
SELECT id, '数据表', 1, true FROM nodes WHERE kind = 'base';

-- Older servers still create Base nodes without knowing about bt_tables.
-- The trigger creates the same identity in their transaction, including
-- when an older create path changes a newly inserted node's kind to base.
CREATE FUNCTION ensure_default_data_table() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.kind = 'base' THEN
        INSERT INTO bt_tables (base_id, name, position, is_default)
        VALUES (NEW.id, '数据表', 1, true)
        ON CONFLICT (base_id) WHERE is_default DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER ensure_default_data_table
AFTER INSERT OR UPDATE OF kind ON nodes
FOR EACH ROW EXECUTE FUNCTION ensure_default_data_table();

-- The default identity remains stable for old URLs. Deleting a Base itself
-- is permitted to cascade its table; deleting or moving the identity alone
-- is not. Future multi-table migrations must explicitly revise this guard.
CREATE FUNCTION protect_default_data_table() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.is_default AND EXISTS (SELECT 1 FROM nodes WHERE id = OLD.base_id) THEN
            RAISE EXCEPTION 'default data table cannot be deleted' USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
    END IF;
    IF NEW.id <> OLD.id OR NEW.base_id <> OLD.base_id OR NEW.is_default <> OLD.is_default THEN
        RAISE EXCEPTION 'default data table identity cannot be changed' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER protect_default_data_table
BEFORE UPDATE OR DELETE ON bt_tables
FOR EACH ROW EXECUTE FUNCTION protect_default_data_table();
