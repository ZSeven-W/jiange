-- 个人 AI 设置：OpenAI 兼容接口地址、模型与加密保存的 API Key（AES-GCM，
-- 服务端密钥来自 JIANGE_SECRET_KEY，数据库中不保存明文）。
CREATE TABLE user_ai_settings (
    user_id        bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    base_url       text   NOT NULL,
    model          text   NOT NULL,
    api_key_cipher bytea  NOT NULL,
    key_hint       text   NOT NULL DEFAULT '',
    updated_at     timestamptz NOT NULL DEFAULT now()
);
