package store

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
)

const maxConditionalOps = 100000
const maxConditionalBytes = 8 << 20
const maxConditionalInteger = 1<<53 - 1

// ConditionalOpsCommitter stores an idempotency receipt atomically with an
// epoch-and-head-guarded batch. Callers must validate authorship and semantic
// dependencies before attempting a new commit.
type ConditionalOpsCommitter interface {
	CommitConditionalOps(context.Context, RestoreGuard, int64, int64, int64, string, []RawOp) ([]int64, error)
	LookupConditionalOps(context.Context, RestoreGuard, int64, int64, int64, string, []RawOp) ([]int64, error)
}

// ConditionalTitleOpsCommitter also updates the directory title in the same
// transaction as the operation log and receipt. The caller must derive the
// new title from the validated CRDT state at the expected history point.
type ConditionalTitleOpsCommitter interface {
	CommitConditionalTitleOps(context.Context, RestoreGuard, int64, int64, int64, string, []RawOp, string, string) ([]int64, error)
}

// A missing receipt is only an observation: a concurrent submission may
// still be in flight and commit after the lookup returns.
type ConditionalOpsStatus struct {
	DocID        int64  `json:"docId"`
	UserID       int64  `json:"userId"`
	RequestID    string `json:"requestId"`
	State        string `json:"state"` // unknown | committed | cancelled | history_changed
	CurrentEpoch int64  `json:"currentEpoch"`
	CurrentHead  int64  `json:"currentHead"`
	Epoch        int64  `json:"historyEpoch"`
	BaseHead     int64  `json:"expectedSeq"`
	First        int64  `json:"firstSeq"`
	Count        int64  `json:"opCount"`
	ClientID     int64  `json:"clientId,omitempty"`
	Digest       string `json:"digest,omitempty"`
}

type ConditionalOpsStatusReader interface {
	ConditionalOpsStatus(context.Context, RestoreGuard, int64, string) (ConditionalOpsStatus, error)
}

// ConditionalOpsCanceller atomically fences a request ID or observes its
// existing receipt. A delayed submission with the same ID cannot commit after
// the cancellation transaction succeeds.
type ConditionalOpsCanceller interface {
	CancelConditionalOps(context.Context, RestoreGuard, int64, int64, int64, int64, int64, string, [32]byte) (ConditionalOpsStatus, error)
}

type conditionalOpsKey struct {
	doc, user int64
	request   string
}
type conditionalOpsReceipt struct {
	epoch, head, first, count int64
	digest                    [32]byte
}
type conditionalCancellation struct {
	epoch, head, count, client int64
	digest                     [32]byte
}

func conditionalDigest(epoch, head int64, request string, ops []RawOp) ([32]byte, error) {
	if !versionRequestPattern.MatchString(request) || epoch < 1 || epoch > maxConditionalInteger || head < 0 || head > maxConditionalInteger || len(ops) == 0 || len(ops) > maxConditionalOps || int64(len(ops)) > maxConditionalInteger-head {
		return [32]byte{}, ErrConflict
	}
	h := sha256.New()
	var word [8]byte
	put := func(value uint64) { binary.BigEndian.PutUint64(word[:], value); _, _ = h.Write(word[:]) }
	put(uint64(epoch))
	put(uint64(head))
	put(uint64(len(ops)))
	total := 0
	for _, op := range ops {
		if op.ClientID <= 0 || op.ClientID > maxConditionalInteger || op.Clock <= 0 || op.Clock > maxConditionalInteger || len(op.Bytes) == 0 || len(op.Bytes) > maxConditionalBytes-total {
			return [32]byte{}, ErrConflict
		}
		total += len(op.Bytes)
		put(uint64(op.ClientID))
		put(uint64(op.Clock))
		put(uint64(len(op.Bytes)))
		_, _ = h.Write(op.Bytes)
	}
	var result [32]byte
	copy(result[:], h.Sum(nil))
	return result, nil
}

func conditionalSequences(receipt conditionalOpsReceipt) []int64 {
	seqs := make([]int64, int(receipt.count))
	for i := range seqs {
		seqs[i] = receipt.first + int64(i)
	}
	return seqs
}
