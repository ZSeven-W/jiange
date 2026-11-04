-- P6: starred docs per user; shown in the sidebar 收藏 section.
CREATE TABLE favorites (
    user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    node_id     bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, node_id)
);
