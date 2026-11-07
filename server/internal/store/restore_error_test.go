package store

import (
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestRetryableRestoreConflict(t *testing.T) {
	for _, code := range []string{"40P01", "40001"} {
		if !retryableRestoreConflict(fmt.Errorf("wrapped: %w", &pgconn.PgError{Code: code})) {
			t.Fatalf("PostgreSQL %s should be retryable", code)
		}
	}
	if retryableRestoreConflict(&pgconn.PgError{Code: "23505"}) || retryableRestoreConflict(fmt.Errorf("network")) {
		t.Fatal("unrelated errors must not be misreported as concurrent document changes")
	}
}
