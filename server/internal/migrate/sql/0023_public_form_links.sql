-- Public forms are opt-in capabilities. Only a one-way digest is stored;
-- existing forms are deliberately not published by this migration.
CREATE TABLE bt_public_form_links (
    view_id bigint PRIMARY KEY REFERENCES bt_views(id) ON DELETE CASCADE,
    base_id bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    token_hash bytea UNIQUE CHECK (token_hash IS NULL OR octet_length(token_hash) = 32),
    revision bigint NOT NULL CHECK (revision >= 0 AND revision <= 9007199254740991),
    window_started timestamptz NOT NULL DEFAULT now(),
    window_count integer NOT NULL DEFAULT 0 CHECK (window_count >= 0)
);

-- A later conversion back to a form must not revive an old public link.
CREATE FUNCTION revoke_form_link_on_type_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.type = 'form' AND NEW.type <> 'form' THEN
        INSERT INTO bt_public_form_links (view_id, base_id, token_hash, revision)
        VALUES (OLD.id, OLD.base_id, NULL, 1)
        ON CONFLICT (view_id) DO UPDATE
        SET token_hash = NULL, revision = bt_public_form_links.revision + 1;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER revoke_form_link_on_type_change
AFTER UPDATE OF type ON bt_views
FOR EACH ROW EXECUTE FUNCTION revoke_form_link_on_type_change();
