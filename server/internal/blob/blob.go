// Package blob stores attachment bytes: in memory (tests) or in an
// S3-compatible bucket such as MinIO, signed with AWS SigV4 (stdlib only).
package blob

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

var ErrNotFound = errors.New("blob not found")

type Store interface {
	Put(ctx context.Context, key, mime string, body []byte) error
	Get(ctx context.Context, key string) (io.ReadCloser, error)
}

// Memory is an in-process blob store.
type Memory struct {
	mu sync.Mutex
	m  map[string][]byte
}

func NewMemory() *Memory { return &Memory{m: map[string][]byte{}} }

func (s *Memory) Put(_ context.Context, key, _ string, body []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[key] = bytes.Clone(body)
	return nil
}

func (s *Memory) Get(_ context.Context, key string) (io.ReadCloser, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, ok := s.m[key]
	if !ok {
		return nil, ErrNotFound
	}
	return io.NopCloser(bytes.NewReader(b)), nil
}

// S3 talks path-style S3 (MinIO) at Endpoint (e.g. http://127.0.0.1:9000).
type S3 struct {
	Endpoint, Region, Bucket, AccessKey, SecretKey string
	Client                                         *http.Client
	Now                                            func() time.Time
}

func (s *S3) client() *http.Client {
	if s.Client != nil {
		return s.Client
	}
	return http.DefaultClient
}

func hmacSHA(key []byte, msg string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(msg))
	return h.Sum(nil)
}

func hexSHA(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// Sign adds SigV4 headers to req for body (nil = empty).
func (s *S3) Sign(req *http.Request, body []byte) {
	now := time.Now().UTC()
	if s.Now != nil {
		now = s.Now().UTC()
	}
	region := s.Region
	if region == "" {
		region = "us-east-1"
	}
	amz := now.Format("20060102T150405Z")
	day := amz[:8]
	payload := hexSHA(body)
	req.Header.Set("x-amz-date", amz)
	req.Header.Set("x-amz-content-sha256", payload)
	host := req.URL.Host
	names := []string{"host", "x-amz-content-sha256", "x-amz-date"}
	canonHeaders := "host:" + host + "\nx-amz-content-sha256:" + payload + "\nx-amz-date:" + amz + "\n"
	path := req.URL.EscapedPath()
	if path == "" {
		path = "/"
	}
	canon := strings.Join([]string{req.Method, path, req.URL.Query().Encode(), canonHeaders, strings.Join(names, ";"), payload}, "\n")
	scope := day + "/" + region + "/s3/aws4_request"
	toSign := "AWS4-HMAC-SHA256\n" + amz + "\n" + scope + "\n" + hexSHA([]byte(canon))
	k := hmacSHA([]byte("AWS4"+s.SecretKey), day)
	k = hmacSHA(k, region)
	k = hmacSHA(k, "s3")
	k = hmacSHA(k, "aws4_request")
	sig := hex.EncodeToString(hmacSHA(k, toSign))
	req.Header.Set("Authorization", fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		s.AccessKey, scope, strings.Join(names, ";"), sig))
}

func (s *S3) do(ctx context.Context, method, key, mime string, body []byte) (*http.Response, error) {
	u := strings.TrimRight(s.Endpoint, "/") + "/" + s.Bucket
	if key != "" {
		u += "/" + (&url.URL{Path: key}).EscapedPath()
	}
	req, err := http.NewRequestWithContext(ctx, method, u, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	if mime != "" {
		req.Header.Set("Content-Type", mime)
	}
	s.Sign(req, body)
	return s.client().Do(req)
}

// EnsureBucket creates the bucket if missing.
func (s *S3) EnsureBucket(ctx context.Context) error {
	resp, err := s.do(ctx, http.MethodPut, "", "", nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == 200 || resp.StatusCode == 409 {
		return nil
	}
	b, _ := io.ReadAll(resp.Body)
	return fmt.Errorf("create bucket: %s %s", resp.Status, b)
}

func (s *S3) Put(ctx context.Context, key, mime string, body []byte) error {
	resp, err := s.do(ctx, http.MethodPut, key, mime, body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("put %s: %s %s", key, resp.Status, b)
	}
	return nil
}

func (s *S3) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	resp, err := s.do(ctx, http.MethodGet, key, "", nil)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == 404 {
		resp.Body.Close()
		return nil, ErrNotFound
	}
	if resp.StatusCode != 200 {
		resp.Body.Close()
		return nil, fmt.Errorf("get %s: %s", key, resp.Status)
	}
	return resp.Body, nil
}
