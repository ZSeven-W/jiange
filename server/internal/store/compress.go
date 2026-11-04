package store

import (
	"bytes"
	"compress/gzip"
	"io"
)

// Snapshot blobs are gzip-compressed at rest; reads transparently decompress
// so the wire protocol (and old, uncompressed rows) keep working.

var gzipMagic = []byte{0x1f, 0x8b}

func compressState(b []byte) []byte {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(b); err != nil {
		return b
	}
	if err := zw.Close(); err != nil {
		return b
	}
	if buf.Len() >= len(b) {
		return b // already dense; keep raw
	}
	return buf.Bytes()
}

func decompressState(b []byte) []byte {
	if len(b) < 2 || !bytes.Equal(b[:2], gzipMagic) {
		return b
	}
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return b
	}
	out, err := io.ReadAll(zr)
	if err != nil {
		return b
	}
	return out
}
