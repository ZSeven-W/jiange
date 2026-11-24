-- Route E4: Long-Tail Suite Parity (Base extended fields & hierarchy view, Sheet sparklines & outline grouping).

-- 1. Base: 5 extended field types (currency, progress, autonumber, button, location).
ALTER TABLE base_fields DROP CONSTRAINT IF EXISTS base_fields_type_check;
ALTER TABLE base_fields ADD CONSTRAINT base_fields_type_check
    CHECK (type IN (
        'text', 'number', 'select', 'checkbox', 'date', 'multi_select', 'person', 'attachment',
        'created_by', 'created_at', 'modified_at', 'url', 'phone', 'email', 'rating', 'formula',
        'link', 'lookup',
        'currency', 'progress', 'autonumber', 'button', 'location'
    ));

-- 2. Base: hierarchy tree view for parent-child tasks via self-link field.
ALTER TABLE bt_views DROP CONSTRAINT IF EXISTS bt_views_type_check;
ALTER TABLE bt_views ADD CONSTRAINT bt_views_type_check
    CHECK (type IN ('grid', 'kanban', 'gallery', 'calendar', 'form', 'gantt', 'hierarchy'));

-- 3. Sheet: persisted inline SVG sparklines and collapsible row/col outline groups per worksheet.
ALTER TABLE sheet_worksheets
    ADD COLUMN IF NOT EXISTS sparklines jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS outline_groups jsonb NOT NULL DEFAULT '[]'::jsonb;
