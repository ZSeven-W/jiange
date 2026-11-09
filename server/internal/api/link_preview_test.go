package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"testing"
)

func TestPublicAddrBlocksInternalRanges(t *testing.T) {
	for _, ip := range []string{"127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "224.0.0.1"} {
		if publicAddr(netip.MustParseAddr(ip)) {
			t.Errorf("%s should be blocked", ip)
		}
	}
	for _, ip := range []string{"1.1.1.1", "93.184.216.34", "2606:4700::1111"} {
		if !publicAddr(netip.MustParseAddr(ip)) {
			t.Errorf("%s should be allowed", ip)
		}
	}
}

func TestFetchPreviewRejectsLoopbackAndBadSchemes(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("<title>secret</title>")) }))
	defer srv.Close()
	c := previewClient(publicAddr)
	if _, err := fetchPreview(context.Background(), c, srv.URL); err == nil {
		t.Fatal("loopback fetch must be refused")
	}
	for _, raw := range []string{"file:///etc/passwd", "gopher://x", "http://user:pw@example.com/", "ftp://example.com", strings.Repeat("a", 3000)} {
		if _, err := fetchPreview(context.Background(), c, raw); err == nil {
			t.Errorf("%q must be refused", raw)
		}
	}
}

func TestFetchPreviewRedirectToInternalIsBlocked(t *testing.T) {
	internal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("<title>secret</title>")) }))
	defer internal.Close()
	internalPort := netip.MustParseAddrPort(strings.TrimPrefix(internal.URL, "http://")).Port()
	front := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, internal.URL, http.StatusFound) }))
	defer front.Close()
	// Allow only the front server's socket; the redirect target must be refused at dial time.
	allowCalls := 0
	c := previewClient(func(ip netip.Addr) bool { allowCalls++; return allowCalls == 1 })
	if _, err := fetchPreview(context.Background(), c, front.URL); err == nil {
		t.Fatalf("redirect to internal port %d must be refused", internalPort)
	}
}

func TestParsePreviewAndSizeCap(t *testing.T) {
	big := strings.Repeat("x", previewMaxBytes+10)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(`<html><head><title> 飞书文档 &amp; 协作 </title><meta name="description" content="在线协作"><meta property="og:site_name" content="飞书"><link rel="icon" href="/img/fav.png"></head><body>` + big + `<title>late</title></body></html>`))
	}))
	defer srv.Close()
	c := previewClient(func(netip.Addr) bool { return true })
	p, err := fetchPreview(context.Background(), c, srv.URL+"/docs")
	if err != nil {
		t.Fatal(err)
	}
	if p.Title != "飞书文档 & 协作" || p.Description != "在线协作" || p.SiteName != "飞书" {
		t.Fatalf("unexpected preview %+v", p)
	}
	u, _ := url.Parse(srv.URL)
	if p.Icon != "http://"+u.Host+"/img/fav.png" {
		t.Fatalf("icon %q", p.Icon)
	}
}

func TestPreviewAllowFromEnv(t *testing.T) {
	if PreviewAllowFromEnv("") != nil || PreviewAllowFromEnv("junk") != nil {
		t.Fatal("empty or invalid config keeps the default")
	}
	allow := PreviewAllowFromEnv("198.18.0.0/15, 127.0.0.0/8")
	if !allow(netip.MustParseAddr("198.18.0.1")) || !allow(netip.MustParseAddr("1.1.1.1")) {
		t.Fatal("configured and public ranges are allowed")
	}
	if allow(netip.MustParseAddr("127.0.0.1")) || allow(netip.MustParseAddr("10.0.0.1")) {
		t.Fatal("loopback and other private ranges stay blocked")
	}
}
