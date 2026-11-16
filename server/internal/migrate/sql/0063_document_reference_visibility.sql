-- Display preference shared by collaborators. It is not an access-control rule.
CREATE TABLE document_reference_visibility (
    doc_id bigint PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
    visible boolean NOT NULL DEFAULT true,
    revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991)
);
