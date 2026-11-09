-- 置顶文档: per-user pinned docs, shown in the sidebar 置顶文档 section.
-- Independent of favorites (收藏), as in Feishu.
CREATE TABLE pins (
    user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    node_id     bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, node_id)
);
