-- Link-derived grants are kept separate from explicit invitations. Existing
-- doc_shares cannot be attributed reliably, so preserve them as invitations.
CREATE TABLE doc_link_joins (
    doc_id bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (doc_id, user_id)
);
CREATE INDEX doc_link_joins_user ON doc_link_joins (user_id);
