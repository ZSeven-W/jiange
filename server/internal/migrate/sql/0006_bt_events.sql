-- P5.6: bitable realtime — an append-only event log per base. Each REST
-- mutation appends one event; the sync hub streams them to connected clients
-- in seq order, giving every cell last-writer-wins semantics.
CREATE TABLE bt_events (
    id      bigserial PRIMARY KEY,
    base_id bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    body    jsonb NOT NULL,
    at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bt_events_base ON bt_events (base_id, id);
