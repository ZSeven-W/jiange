-- P5: saved views — filter/sort/group/hidden-field configs per base, compiled
-- to SQL server-side (see internal/btquery).
CREATE TABLE bt_views (
    id       bigserial PRIMARY KEY,
    base_id  bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    type     text NOT NULL DEFAULT 'grid' CHECK (type IN ('grid', 'kanban')),
    name     text NOT NULL DEFAULT '表格视图',
    config   jsonb NOT NULL DEFAULT '{}',
    pos      double precision NOT NULL DEFAULT 0
);
CREATE INDEX bt_views_base ON bt_views (base_id, pos);
