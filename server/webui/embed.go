// Package webui embeds the built frontend (apps/web/dist, copied here by the
// build) and serves it. When only the placeholder exists (a dev build), Dist
// is empty and the server serves just the API.
package webui

import (
	"embed"
	"io/fs"
	"net/http"
)

//go:embed all:dist
var dist embed.FS

// Dist reports whether a built frontend is embedded.
func Built() bool {
	entries, err := dist.ReadDir("dist")
	return err == nil && len(entries) > 0
}

// Handler serves the SPA (hash routing, so / alone is enough).
func Handler() http.Handler {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		return nil
	}
	return http.FileServer(http.FS(sub))
}
