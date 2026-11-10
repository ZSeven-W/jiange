package blob

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestDirStore(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	d, err := NewDir(filepath.Join(root, "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	if err := d.Put(ctx, "docs/1/abc", "text/plain", []byte("hello")); err != nil {
		t.Fatal(err)
	}
	got, err := d.Get(ctx, "docs/1/abc")
	if err != nil {
		t.Fatal(err)
	}
	b, err := io.ReadAll(got)
	got.Close()
	if err != nil || !bytes.Equal(b, []byte("hello")) {
		t.Fatalf("got %q err=%v", b, err)
	}
	if size, err := d.Size(ctx, "docs/1/abc"); err != nil || size != 5 {
		t.Fatalf("size=%d err=%v", size, err)
	}
	if err := d.Put(ctx, "docs/1/abc", "text/plain", []byte("replaced")); err != nil {
		t.Fatal(err)
	}
	if size, err := d.Size(ctx, "docs/1/abc"); err != nil || size != 8 {
		t.Fatalf("replaced size=%d err=%v", size, err)
	}
	if err := d.Delete(ctx, "docs/1/abc"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Get(ctx, "docs/1/abc"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted get: %v", err)
	}
	if _, err := d.Size(ctx, "docs/1/abc"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted size: %v", err)
	}
	if err := d.Delete(ctx, "docs/1/abc"); err != nil {
		t.Fatalf("delete missing: %v", err)
	}
}

func TestDirRejectsBadKeys(t *testing.T) {
	ctx := context.Background()
	d, err := NewDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	bad := []string{
		"",
		"/abs",
		"..",
		"../escape",
		"docs/../secret",
		"docs//abc",
		"docs/./abc",
		`docs\abc`,
		"docs/ab c",
		"docs/abc\n",
		"docs/abc/../x",
	}
	for _, key := range bad {
		if err := d.Put(ctx, key, "text/plain", []byte("x")); !errors.Is(err, ErrBadKey) {
			t.Errorf("Put(%q) = %v, want ErrBadKey", key, err)
		}
		if _, err := d.Get(ctx, key); !errors.Is(err, ErrBadKey) {
			t.Errorf("Get(%q) = %v, want ErrBadKey", key, err)
		}
		if err := d.Delete(ctx, key); !errors.Is(err, ErrBadKey) {
			t.Errorf("Delete(%q) = %v, want ErrBadKey", key, err)
		}
		if _, err := d.Size(ctx, key); !errors.Is(err, ErrBadKey) {
			t.Errorf("Size(%q) = %v, want ErrBadKey", key, err)
		}
	}
}

func TestDirGetOnDirectoryIsNotFound(t *testing.T) {
	ctx := context.Background()
	d, err := NewDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := d.Put(ctx, "docs/1/abc", "text/plain", []byte("x")); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Get(ctx, "docs/1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get on parent dir: %v", err)
	}
	if _, err := d.Size(ctx, "docs/1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Size on parent dir: %v", err)
	}
}

func TestDirCanceledContext(t *testing.T) {
	d, err := NewDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := d.Put(ctx, "docs/1/abc", "text/plain", []byte("x")); !errors.Is(err, context.Canceled) {
		t.Fatalf("Put canceled: %v", err)
	}
}

func TestDirPersistsAcrossOpen(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	d, err := NewDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := d.Put(ctx, "drive/9/ff00", "image/png", []byte("png")); err != nil {
		t.Fatal(err)
	}
	d2, err := NewDir(root)
	if err != nil {
		t.Fatal(err)
	}
	got, err := d2.Get(ctx, "drive/9/ff00")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(got)
	got.Close()
	if !bytes.Equal(b, []byte("png")) {
		t.Fatalf("persisted %q", b)
	}
	if _, err := os.Stat(filepath.Join(root, "drive", "9", "ff00")); err != nil {
		t.Fatal(err)
	}
}
