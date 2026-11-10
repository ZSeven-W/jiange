// Package config reads runtime configuration from environment variables.
package config

import (
	"os"
	"strings"
	"time"
)

type Config struct {
	Addr          string
	DatabaseURL   string
	SessionTTL    time.Duration
	SecureCookies bool
	// AllowedOrigins are extra browser origins (host[:port]) allowed to open sync sockets.
	AllowedOrigins []string
	// S3/MinIO attachment storage; empty endpoint disables uploads unless BlobDir is set.
	S3Endpoint, S3Bucket, S3AccessKey, S3SecretKey string
	// BlobDir, if set, stores attachments on the local filesystem (takes precedence over S3).
	BlobDir string
	// AutoVersionEvery: docs edited within this window get an automatic
	// version snapshot each sweep; 0 disables.
	AutoVersionEvery time.Duration
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func Load() Config {
	ttl, err := time.ParseDuration(getenv("JIANGE_SESSION_TTL", "720h"))
	if err != nil {
		ttl = 720 * time.Hour
	}
	auto, err := time.ParseDuration(getenv("JIANGE_AUTO_VERSION_EVERY", "30m"))
	if err != nil {
		auto = 30 * time.Minute
	}
	return Config{
		Addr:          getenv("JIANGE_ADDR", ":8080"),
		DatabaseURL:   getenv("DATABASE_URL", "postgres://jiange:jiange@localhost:5432/jiange?sslmode=disable"),
		SessionTTL:    ttl,
		SecureCookies: getenv("JIANGE_SECURE_COOKIES", "false") == "true",
		S3Endpoint:    os.Getenv("JIANGE_S3_ENDPOINT"),
		S3Bucket:      getenv("JIANGE_S3_BUCKET", "jiange"),
		S3AccessKey:   os.Getenv("JIANGE_S3_ACCESS_KEY"),
		S3SecretKey:   os.Getenv("JIANGE_S3_SECRET_KEY"),
		BlobDir:       os.Getenv("JIANGE_BLOB_DIR"),
		AllowedOrigins: strings.FieldsFunc(getenv("JIANGE_ALLOWED_ORIGINS", "localhost:5173,127.0.0.1:5173"),
			func(r rune) bool { return r == ',' || r == ' ' }),
		AutoVersionEvery: auto,
	}
}
