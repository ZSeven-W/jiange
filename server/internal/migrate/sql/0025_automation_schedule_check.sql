-- 0020 introduced scheduled automations but did not update the original
-- trigger-kind constraint, so PostgreSQL rejected every scheduled rule.
ALTER TABLE bt_automations DROP CONSTRAINT IF EXISTS bt_automations_trigger_kind_check;
ALTER TABLE bt_automations ADD CONSTRAINT bt_automations_trigger_kind_check
  CHECK (trigger_kind IN ('form_submit', 'record_matches', 'schedule'));
