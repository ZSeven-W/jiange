-- P5: extend view types with gallery / calendar / form.
ALTER TABLE bt_views DROP CONSTRAINT bt_views_type_check;
ALTER TABLE bt_views ADD CONSTRAINT bt_views_type_check
    CHECK (type IN ('grid', 'kanban', 'gallery', 'calendar', 'form'));
