package store

import (
	"bytes"
	"compress/gzip"
	"errors"
	"testing"
)

func TestDecodeTitleSnapshotBoundsAndCorruption(t *testing.T) {
	if _, err := decodeTitleSnapshot([]byte{0x1f, 0x8b, 0}); err == nil {
		t.Fatal("corrupt gzip accepted")
	}
	var b bytes.Buffer
	z := gzip.NewWriter(&b)
	chunk := make([]byte, 1<<20)
	for i := 0; i < 65; i++ {
		if _, err := z.Write(chunk); err != nil {
			t.Fatal(err)
		}
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := decodeTitleSnapshot(b.Bytes()); !errors.Is(err, ErrTitleSnapshotTooLarge) {
		t.Fatalf("limit: %v", err)
	}
}
