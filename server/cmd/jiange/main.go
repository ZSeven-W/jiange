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
	"github.com/ZSeven-W/jiange/server/internal/backup"
	"github.com/ZSeven-W/jiange/server/internal/blob"
	"github.com/ZSeven-W/jiange/server/internal/btsync"
	"github.com/ZSeven-W/jiange/server/internal/config"
	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/sheetsync"
	"github.com/ZSeven-W/jiange/server/internal/slidessync"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/ZSeven-W/jiange/server/internal/syncsrv"
	"github.com/ZSeven-W/jiange/server/webui"
)

// autoVersions retries all unversioned heads, including changes made while the service was offline.
func autoVersions(ctx context.Context, log *slog.Logger, pg *store.Postgres, every time.Duration) {
	sweep := func() {
		created, err := api.SweepAutomaticVersions(ctx, pg, log)
		if err != nil && ctx.Err() == nil {
			log.Error("automatic version sweep", "error", err)
		}
		if created > 0 {
			log.Info("automatic versions created", "count", created)
		}
	}
	sweep()
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sweep()
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
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "migrate":
			return nil
		case "backup":
			if len(os.Args) < 3 {
				return errors.New("usage: jiange backup <output.tar.gz>")
			}
			manifest, err := backup.ExportPostgresDir(ctx, pg, cfg.BlobDir, os.Args[2])
			if err != nil {
				return err
			}
			log.Info("backup exported", "path", os.Args[2], "tables", len(manifest.Tables), "blobs", manifest.BlobCount)
			return nil
		case "restore":
			if len(os.Args) < 3 {
				return errors.New("usage: jiange restore <input.tar.gz>")
			}
			var restoreBlobs blob.Store
			switch {
			case cfg.BlobDir != "":
				dir, err := blob.NewDir(cfg.BlobDir)
				if err != nil {
					return err
				}
				restoreBlobs = dir
			case cfg.S3Endpoint != "":
				s3 := &blob.S3{Endpoint: cfg.S3Endpoint, Bucket: cfg.S3Bucket, AccessKey: cfg.S3AccessKey, SecretKey: cfg.S3SecretKey}
				if err := s3.EnsureBucket(ctx); err != nil {
					return err
				}
				restoreBlobs = s3
			}
			manifest, err := backup.RestorePostgresDir(ctx, pg, restoreBlobs, os.Args[2])
			if err != nil {
				return err
			}
			log.Info("backup restored", "path", os.Args[2], "tables", len(manifest.Tables), "blobs", manifest.BlobCount)
			return nil
		}
	}

	hub := &syncsrv.Hub{Store: pg, Log: log, OriginPatterns: cfg.AllowedOrigins}
	go func() {
		if err := hub.Run(ctx); err != nil {
			log.Error("listen/notify", "err", err)
		}
	}()
	btHub := &btsync.Hub{Store: pg, Bus: pg, Log: log, OriginPatterns: cfg.AllowedOrigins}
	go func() {
		if err := btHub.Run(ctx); err != nil {
			log.Error("btsync listen/notify", "err", err)
		}
	}()
	sheetHub := &sheetsync.Hub{Store: pg, Bus: pg, Log: log, OriginPatterns: cfg.AllowedOrigins}
	go func() {
		if err := sheetHub.Run(ctx); err != nil {
			log.Error("sheetsync listen/notify", "err", err)
		}
	}()
	slidesHub := &slidessync.Hub{Bus: pg, Log: log, OriginPatterns: cfg.AllowedOrigins}
	go func() {
		if err := slidesHub.Run(ctx); err != nil {
			log.Error("slidessync listen/notify", "err", err)
		}
	}()
	if cfg.AutoVersionEvery > 0 {
		go autoVersions(ctx, log, pg, cfg.AutoVersionEvery)
	}
	// 企业数据保留策略定时清扫：启动延迟 1 分钟后每小时执行一次
	go func() {
		sweep := func() {
			if _, err := api.SweepRetentionPolicies(ctx, pg, log); err != nil && ctx.Err() == nil {
				log.Error("retention sweep", "err", err)
			}
		}
		timer := time.NewTimer(time.Minute)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			sweep()
		}
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				sweep()
			}
		}
	}()
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
			EnableConditionalCancel: cfg.EnableConditionalCancel,
			Hub:                     hub, BtHub: btHub, SheetHub: sheetHub, SlidesHub: slidesHub, Blobs: blobs, WebUI: webui.Handler(), PreviewAllow: api.PreviewAllowFromEnv(os.Getenv("JIANGE_LINK_PREVIEW_ALLOW_CIDRS")), AISecret: api.AISecretFromEnv(os.Getenv("JIANGE_SECRET_KEY"))}).Handler(),
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
