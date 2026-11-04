-- Bitable v2: automations. One config jsonb holds trigger filter rules and
-- the notify action (users + message template with {{字段名}} interpolation).
CREATE TABLE bt_automations (
    id           bigserial PRIMARY KEY,
    base_id      bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    name         text NOT NULL,
    enabled      bool NOT NULL DEFAULT true,
    trigger_kind text NOT NULL CHECK (trigger_kind IN ('form_submit', 'record_matches')),
    config       jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX bt_automations_base ON bt_automations (base_id, id);
