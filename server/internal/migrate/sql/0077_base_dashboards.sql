-- Configurable multi-widget dashboards persisted per Base.
CREATE TABLE IF NOT EXISTS bt_dashboards (
  id         bigserial PRIMARY KEY,
  base_id    bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  name       text NOT NULL DEFAULT '仪表盘',
  widgets    jsonb NOT NULL DEFAULT '[]'::jsonb,
  revision   bigint NOT NULL DEFAULT 1,
  updated_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bt_dashboards_base ON bt_dashboards(base_id, id);
