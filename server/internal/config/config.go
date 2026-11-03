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
	// S3/MinIO attachment storage; empty endpoint disables uploads.
	S3Endpoint, S3Bucket, S3AccessKey, S3SecretKey string
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
	return Config{
		Addr:          getenv("JIANGE_ADDR", ":8080"),
		DatabaseURL:   getenv("DATABASE_URL", "postgres://jiange:jiange@localhost:5432/jiange?sslmode=disable"),
		SessionTTL:    ttl,
		SecureCookies: getenv("JIANGE_SECURE_COOKIES", "false") == "true",
		S3Endpoint:    os.Getenv("JIANGE_S3_ENDPOINT"),
		S3Bucket:      getenv("JIANGE_S3_BUCKET", "jiange"),
		S3AccessKey:   os.Getenv("JIANGE_S3_ACCESS_KEY"),
		S3SecretKey:   os.Getenv("JIANGE_S3_SECRET_KEY"),
		AllowedOrigins: strings.FieldsFunc(getenv("JIANGE_ALLOWED_ORIGINS", "localhost:5173,127.0.0.1:5173"),
			func(r rune) bool { return r == ',' || r == ' ' }),
	}
}
