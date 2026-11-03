-- P5: bitable (多维表格) — a base node owns typed fields and records.
CREATE TABLE base_fields (
    id       bigserial PRIMARY KEY,
    base_id  bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    name     text NOT NULL,
    type     text NOT NULL CHECK (type IN ('text', 'number', 'select', 'checkbox', 'date')),
    options  jsonb NOT NULL DEFAULT '[]',
    position double precision NOT NULL
);
CREATE INDEX base_fields_base ON base_fields (base_id, position);

CREATE TABLE base_records (
    id         bigserial PRIMARY KEY,
    base_id    bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    cells      jsonb NOT NULL DEFAULT '{}',
    position   double precision NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX base_records_base ON base_records (base_id, position);
