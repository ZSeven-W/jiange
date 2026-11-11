-- 评论表情回应: one row per (comment, user, emoji); deleting the comment or
-- the user removes the reaction.
CREATE TABLE comment_reactions (
    comment_id bigint NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      text   NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 8),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (comment_id, user_id, emoji)
);
