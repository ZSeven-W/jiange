-- Foundation for P2 (sync server): directory tree, op log and snapshots.
CREATE TABLE nodes (
    id           bigserial PRIMARY KEY,
    workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    parent_id    bigint REFERENCES nodes(id) ON DELETE CASCADE,
    kind         text NOT NULL CHECK (kind IN ('doc', 'base')),
    sort_key     text NOT NULL,
    title        text NOT NULL DEFAULT '',
    icon         text NOT NULL DEFAULT '',
    creator_id   bigint NOT NULL REFERENCES users(id),
    created_at   timestamptz NOT NULL DEFAULT now(),
    deleted_at   timestamptz
);
CREATE INDEX nodes_tree ON nodes (workspace_id, parent_id, sort_key);

CREATE TABLE doc_ops (
    doc_id     bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    seq        bigint NOT NULL,
    client_id  bigint NOT NULL,
    op         bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (doc_id, seq)
);

CREATE TABLE doc_snapshots (
    doc_id     bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    seq        bigint NOT NULL,
    state      bytea NOT NULL,
    is_version boolean NOT NULL DEFAULT false,
    label      text NOT NULL DEFAULT '',
    created_by bigint REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (doc_id, seq)
);
