-- Who caused each base event (record history 「<name> 修改了记录」).
-- actor_kind: 'user' (signed-in member), 'form' (anonymous public form), NULL for legacy rows.
ALTER TABLE bt_events ADD COLUMN actor_id bigint REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE bt_events ADD COLUMN actor_kind text;
