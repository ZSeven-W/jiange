package store

import (
	"encoding/hex"
	"errors"
	"testing"
)

func TestConditionalDigestVector(t *testing.T) {
	batch, err := hex.DecodeString("4a0101050904000200000103e794b2")
	if err != nil {
		t.Fatal(err)
	}
	digest, err := conditionalDigest(2, 3, "0123456789abcdef0123456789abcdef", []RawOp{{ClientID: 9, Clock: 4, Bytes: batch}})
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(digest[:]); got != "cfc24dd38d45569dee454d431f0f256f33aa38ce0fdb5cdd75deb2b84da779fc" {
		t.Fatalf("digest mismatch: %s", got)
	}
}

func TestConditionalStatusRejectsOverflowInPriorEpoch(t *testing.T) {
	receipt := &conditionalOpsReceipt{epoch: 1, head: maxConditionalInteger - 1, first: maxConditionalInteger, count: 2}
	if _, err := conditionalStatus(1, 1, "0123456789abcdef0123456789abcdef", 2, 0, receipt); !errors.Is(err, ErrConflict) {
		t.Fatalf("overflowing old receipt should be rejected, got %v", err)
	}
}
