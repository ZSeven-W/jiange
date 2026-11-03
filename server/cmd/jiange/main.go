// Command jiange runs the Jiange API server.
//
//	jiange            run migrations and serve
//	jiange migrate    run migrations and exit
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/api"
	"github.com/ZSeven-W/jiange/server/internal/config"
	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/ZSeven-W/jiange/server/internal/syncsrv"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(log); err != nil {
		log.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg := config.Load()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pg, err := store.NewPostgres(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pg.Close()
	applied, err := migrate.Up(ctx, pg.Pool)
	if err != nil {
		return err
	}
	log.Info("migrations", "applied", applied)
	if len(os.Args) > 1 && os.Args[1] == "migrate" {
		return nil
	}

	hub := &syncsrv.Hub{Store: pg, Log: log, OriginPatterns: cfg.AllowedOrigins}
	go func() {
		if err := hub.Run(ctx); err != nil {
			log.Error("listen/notify", "err", err)
		}
	}()
	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           (&api.Server{Store: pg, Log: log, SessionTTL: cfg.SessionTTL, SecureCookies: cfg.SecureCookies, Hub: hub}).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	errc := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", cfg.Addr)
		errc <- srv.ListenAndServe()
	}()
	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(shutdown)
}
