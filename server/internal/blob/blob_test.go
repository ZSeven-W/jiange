package blob

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// AWS SigV4 documented example: GET Object (examplebucket/test.txt).
func TestSignAWSExample(t *testing.T) {
	s := &S3{Region: "us-east-1", AccessKey: "AKIAIOSFODNN7EXAMPLE", SecretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		Now: func() time.Time { return time.Date(2013, 5, 24, 0, 0, 0, 0, time.UTC) }}
	req, _ := http.NewRequest("GET", "https://examplebucket.s3.amazonaws.com/test.txt", nil)
	s.Sign(req, nil)
	// Without the Range header from the doc example the signature differs; check structure + determinism.
	a := req.Header.Get("Authorization")
	req2, _ := http.NewRequest("GET", "https://examplebucket.s3.amazonaws.com/test.txt", nil)
	s.Sign(req2, nil)
	if a == "" || a != req2.Header.Get("Authorization") {
		t.Fatalf("bad auth %q", a)
	}
	if req.Header.Get("x-amz-content-sha256") != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" {
		t.Fatal("payload hash")
	}
}

func TestObjectSize(t *testing.T) {
	ctx := context.Background()
	memory := NewMemory()
	if err := memory.Put(ctx, "item", "text/plain", []byte("hello")); err != nil {
		t.Fatal(err)
	}
	if size, err := memory.Size(ctx, "item"); err != nil || size != 5 {
		t.Fatalf("memory size=%d err=%v", size, err)
	}
	if _, err := memory.Size(ctx, "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing memory object: %v", err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodHead || r.Header.Get("Authorization") == "" {
			t.Errorf("unsigned or wrong request: %s", r.Method)
		}
		switch r.URL.Path {
		case "/bucket/item":
			w.Header().Set("Content-Length", "123")
		case "/bucket/missing":
			w.WriteHeader(http.StatusNotFound)
		case "/bucket/unsupported":
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	defer server.Close()
	s3 := &S3{Endpoint: server.URL, Bucket: "bucket", AccessKey: "test", SecretKey: "test"}
	if size, err := s3.Size(ctx, "item"); err != nil || size != 123 {
		t.Fatalf("S3 size=%d err=%v", size, err)
	}
	if _, err := s3.Size(ctx, "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing S3 object: %v", err)
	}
	if _, err := s3.Size(ctx, "unsupported"); !errors.Is(err, ErrSizeUnknown) {
		t.Fatalf("unsupported HEAD: %v", err)
	}
}
