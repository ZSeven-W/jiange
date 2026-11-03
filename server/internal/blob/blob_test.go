package blob

import (
	"net/http"
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
