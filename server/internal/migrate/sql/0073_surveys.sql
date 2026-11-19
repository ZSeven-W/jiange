-- Standalone Questionnaire / Survey node kind (`survey`) with rich question
-- types, skip logic, publish/close controls, anonymous collection, and
-- structured response storage for visual analytics.
ALTER TABLE nodes DROP CONSTRAINT nodes_kind_check;
ALTER TABLE nodes ADD CONSTRAINT nodes_kind_check CHECK (kind IN ('doc', 'base', 'folder', 'slides', 'file', 'sheet', 'survey'));

CREATE TABLE IF NOT EXISTS surveys (
  node_id         BIGINT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  description     TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'closed')),
  public_token    TEXT UNIQUE,
  allow_anonymous BOOLEAN NOT NULL DEFAULT true,
  max_responses   INTEGER NOT NULL DEFAULT 0 CHECK (max_responses >= 0),
  questions       JSONB NOT NULL DEFAULT '[]'::jsonb,
  revision        BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1 AND revision <= 9007199254740991),
  published_at    TIMESTAMPTZ,
  closed_at       TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS survey_responses (
  id              BIGSERIAL PRIMARY KEY,
  survey_id       BIGINT NOT NULL REFERENCES surveys(node_id) ON DELETE CASCADE,
  respondent_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  respondent_name TEXT NOT NULL DEFAULT '',
  answers         JSONB NOT NULL DEFAULT '{}'::jsonb,
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS survey_responses_survey_idx
  ON survey_responses(survey_id, submitted_at DESC, id DESC);
