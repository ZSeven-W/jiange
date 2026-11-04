-- Automations v2: scheduled triggers. last_fired_at prevents the sweeper
-- from re-firing within the interval.
ALTER TABLE bt_automations ADD COLUMN IF NOT EXISTS last_fired_at timestamptz;
