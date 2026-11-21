# Jiange Go SDK — PostgreSQL Store (`github.com/ZSeven-W/jiange/sdk/go-pgstore`)

Optional, **zero-third-party-dependency** PostgreSQL adapter implementing `github.com/ZSeven-W/jiange/sdk/go/storage.Store` directly on Go's standard `database/sql` package using native PostgreSQL (`$1..$N`) parameter placeholders.

Bring your preferred PostgreSQL `database/sql` driver (`github.com/jackc/pgx/v5/stdlib`, `github.com/lib/pq`, etc.) and plug `*pgstore.Store` straight into `server.New` or any individual `sdk/go/*` domain handler (`sheet`, `doc`, `slides`, `whiteboard`, `base`).

## Installation

```bash
go get github.com/ZSeven-W/jiange/sdk/go-pgstore
go get github.com/jackc/pgx/v5/stdlib # or github.com/lib/pq
```

## Quickstart (`pgx/v5/stdlib` + `server.New`)

```go
package main

import (
	"context"
	"database/sql"
	"log"
	"net/http"
	"os"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/ZSeven-W/jiange/sdk/go/server"
	pgstore "github.com/ZSeven-W/jiange/sdk/go-pgstore"
)

func main() {
	ctx := context.Background()

	db, err := sql.Open("pgx", os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	store, err := pgstore.New(db, pgstore.WithTableName("jiange_sdk_records"))
	if err != nil {
		log.Fatal(err)
	}
	if err := store.EnsureSchema(ctx); err != nil {
		log.Fatal(err)
	}

	jiange := server.New(server.Config{Store: store})
	log.Fatal(http.ListenAndServe(":8080", jiange))
}
```

## Schema & Optimistic Concurrency

`EnsureSchema(ctx)` idempotently creates the backing table and composite `(kind, id)` index:

```sql
CREATE TABLE IF NOT EXISTS jiange_sdk_records (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    version BIGINT NOT NULL,
    data BYTEA,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jiange_sdk_records_kind_id
    ON jiange_sdk_records (kind, id);
```

- **Create (`rec.Version == 0`)**: executes an atomic `INSERT ... ON CONFLICT (id) DO NOTHING`; returns `storage.ErrVersionConflict` if a document with the same `id` already exists.
- **Update (`rec.Version > 0`)**: executes an atomic `UPDATE ... SET version = version + 1, ... WHERE id = $6 AND version = $7 RETURNING version, created_at`; returns `storage.ErrVersionConflict` if missing or version-mismatched while preserving `created_at`.
- **Table Name Safety**: `WithTableName` validates identifiers strictly against `^[a-z_][a-z0-9_]*$` to prevent SQL injection (default: `jiange_sdk_records`).
- **Connection Ownership**: the caller retains ownership of `*sql.DB` (pool settings, timeouts, and `db.Close()`).

## Verification

```bash
test -z "$(gofmt -l .)"
go vet ./...
go test -count=1 -race -cover ./...
```
