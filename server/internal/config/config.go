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
		AllowedOrigins: strings.FieldsFunc(getenv("JIANGE_ALLOWED_ORIGINS", "localhost:5173,127.0.0.1:5173"),
			func(r rune) bool { return r == ',' || r == ' ' }),
	}
}
