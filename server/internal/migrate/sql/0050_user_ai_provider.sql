-- AI 接口协议：openai（Chat Completions 兼容）或 anthropic（Messages API）。
ALTER TABLE user_ai_settings ADD COLUMN provider text NOT NULL DEFAULT 'openai' CHECK (provider IN ('openai', 'anthropic'));
