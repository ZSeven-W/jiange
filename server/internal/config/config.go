// Package config reads runtime configuration from environment variables.
package config

import (
	"os"
	"time"
)

type Config struct {
	Addr          string
	DatabaseURL   string
	SessionTTL    time.Duration
	SecureCookies bool
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
	}
}
