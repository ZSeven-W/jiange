-- 我的模板：用户从文档或块菜单「保存为模板」的 Markdown 内容，仅本人可见。
CREATE TABLE user_templates (
    id         bigserial PRIMARY KEY,
    user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       text   NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
    body       text   NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_templates_user ON user_templates (user_id, id DESC);
