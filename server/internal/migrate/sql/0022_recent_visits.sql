-- Per-user visit history is independent of document update time and grants.
CREATE TABLE recent_visits (
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    node_id bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    viewed_at timestamptz NOT NULL,
    PRIMARY KEY (user_id, node_id)
);
CREATE INDEX recent_visits_order ON recent_visits (user_id, viewed_at DESC, node_id DESC);
