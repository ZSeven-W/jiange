package store

import (
	"bytes"
	"testing"
)

func TestStateCompressionRoundTrip(t *testing.T) {
	// repetitive op-log-ish data compresses well
	raw := bytes.Repeat([]byte{0x05, 0x00, 0x00, 0x00, 0x41}, 10000)
	z := compressState(raw)
	if len(z) >= len(raw) {
		t.Fatalf("expected compression, got %d -> %d", len(raw), len(z))
	}
	if out := decompressState(z); !bytes.Equal(out, raw) {
		t.Fatal("round trip mismatch")
	}
	// tiny payloads stay raw, and raw input passes through
	small := []byte{1, 2, 3}
	if !bytes.Equal(decompressState(small), small) || !bytes.Equal(compressState(small), small) {
		t.Fatal("small payloads should stay raw")
	}
}
