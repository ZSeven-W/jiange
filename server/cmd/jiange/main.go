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
	"github.com/ZSeven-W/jiange/server/internal/blob"
	"github.com/ZSeven-W/jiange/server/internal/btsync"
	"github.com/ZSeven-W/jiange/server/internal/config"
	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/ZSeven-W/jiange/server/internal/syncsrv"
	"github.com/ZSeven-W/jiange/server/webui"
)

// autoVersions periodically snapshots recently edited docs as named versions.
func autoVersions(ctx context.Context, log *slog.Logger, pg *store.Postgres, every time.Duration) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(every):
			ids, err := pg.RecentDocIDs(ctx, time.Now().Add(-every))
			if err != nil {
				log.Error("auto versions", "err", err)
				continue
			}
			for _, id := range ids {
				func() {
					d, head, err := api.StateAtHead(ctx, pg, id)
					if err != nil || head == 0 {
						return
					}
					if err := pg.SaveSnapshot(ctx, id, head, d.EncodeState()); err != nil {
						return
					}
					_ = pg.SaveVersion(ctx, id, head, "自动保存", 0)
					log.Info("auto version", "doc", id, "seq", head)
				}()
			}
		}
	}
}

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
	btHub := &btsync.Hub{Store: pg, Log: log, OriginPatterns: cfg.AllowedOrigins}
	if cfg.AutoVersionEvery > 0 {
		go autoVersions(ctx, log, pg, cfg.AutoVersionEvery)
	}
	// 自动化定时触发：每分钟扫一次到期任务
	go func() {
		apiSrv := &api.Server{Store: pg, Log: log}
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				apiSrv.SweepSchedules(ctx)
			}
		}
	}()
	var blobs blob.Store
	switch {
	case cfg.BlobDir != "":
		dir, err := blob.NewDir(cfg.BlobDir)
		if err != nil {
			return err
		}
		blobs = dir
		log.Info("attachments on disk", "dir", dir.Root)
	case cfg.S3Endpoint != "":
		s3 := &blob.S3{Endpoint: cfg.S3Endpoint, Bucket: cfg.S3Bucket, AccessKey: cfg.S3AccessKey, SecretKey: cfg.S3SecretKey}
		if err := s3.EnsureBucket(ctx); err != nil {
			log.Warn("attachments disabled", "err", err)
		} else {
			blobs = s3
		}
	}
	srv := &http.Server{
		Addr: cfg.Addr,
		Handler: (&api.Server{Store: pg, Log: log, SessionTTL: cfg.SessionTTL, SecureCookies: cfg.SecureCookies,
			Hub: hub, BtHub: btHub, Blobs: blobs, WebUI: webui.Handler(), PreviewAllow: api.PreviewAllowFromEnv(os.Getenv("JIANGE_LINK_PREVIEW_ALLOW_CIDRS"))}).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	if webui.Built() {
		log.Info("web ui embedded at /")
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
