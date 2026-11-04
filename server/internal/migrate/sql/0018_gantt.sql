-- Bitable v2: gantt view type.
ALTER TABLE bt_views DROP CONSTRAINT bt_views_type_check;
ALTER TABLE bt_views ADD CONSTRAINT bt_views_type_check
    CHECK (type IN ('grid', 'kanban', 'gallery', 'calendar', 'form', 'gantt'));
