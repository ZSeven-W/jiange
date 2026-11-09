package api

import (
	"context"
	"errors"
	"html"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
)

// 网页卡片预览：服务端抓取目标页 <title>/描述/图标。
// SSRF 防护：仅 http/https；在建立连接时校验解析后的 IP（防 DNS 重绑定），
// 拒绝回环、私有、链路本地、组播、未指定、CGNAT 与 IPv4 映射私有地址；
// 总超时 5 秒、最多 3 次跳转、只读取前 512KB 且仅解析 HTML。

const (
	previewTimeout  = 5 * time.Second
	previewMaxBytes = 512 << 10
	previewMaxURL   = 2048
)

type LinkPreview struct {
	URL         string `json:"url"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	Icon        string `json:"icon,omitempty"`
	SiteName    string `json:"siteName,omitempty"`
}

var errBlockedAddress = errors.New("blocked address")

// publicAddr reports whether ip is a globally routable unicast address.
func publicAddr(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsValid() || ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return false
	}
	for _, p := range blockedPrefixes {
		if p.Contains(ip) {
			return false
		}
	}
	return true
}

var blockedPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"), // CGNAT
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("64:ff9b::/96"), // NAT64 can reach IPv4 internals
	netip.MustParsePrefix("fc00::/7"),
}

// PreviewAllowFromEnv extends the public-address check with operator-approved
// CIDRs (e.g. a fake-IP egress proxy range). Empty or invalid input keeps the
// default check; loopback can never be allowed this way.
func PreviewAllowFromEnv(raw string) func(netip.Addr) bool {
	var extra []netip.Prefix
	for _, part := range strings.Split(raw, ",") {
		if p, err := netip.ParsePrefix(strings.TrimSpace(part)); err == nil {
			extra = append(extra, p.Masked())
		}
	}
	if len(extra) == 0 {
		return nil
	}
	return func(ip netip.Addr) bool {
		if publicAddr(ip) {
			return true
		}
		ip = ip.Unmap()
		if ip.IsLoopback() || ip.IsUnspecified() {
			return false
		}
		for _, p := range extra {
			if p.Contains(ip) {
				return true
			}
		}
		return false
	}
}

func previewClient(allow func(netip.Addr) bool) *http.Client {
	dialer := &net.Dialer{
		Timeout: previewTimeout,
		Control: func(network, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return errBlockedAddress
			}
			ip, err := netip.ParseAddr(host)
			if err != nil || !allow(ip) {
				return errBlockedAddress
			}
			return nil
		},
	}
	transport := &http.Transport{
		Proxy:                  nil, // 不经代理，确保 Control 校验的是真实目标
		DialContext:            dialer.DialContext,
		TLSHandshakeTimeout:    previewTimeout,
		ResponseHeaderTimeout:  previewTimeout,
		MaxResponseHeaderBytes: 64 << 10,
		DisableKeepAlives:      true,
	}
	return &http.Client{
		Timeout:   previewTimeout,
		Transport: transport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 3 {
				return errors.New("too many redirects")
			}
			if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
				return errors.New("bad scheme")
			}
			return nil
		},
	}
}

var (
	reTitle  = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
	reMeta   = regexp.MustCompile(`(?is)<meta\s+[^>]*>`)
	reLink   = regexp.MustCompile(`(?is)<link\s+[^>]*>`)
	reAttr   = regexp.MustCompile(`(?is)([a-z:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))`)
	reSpaces = regexp.MustCompile(`\s+`)
)

func attrs(tag string) map[string]string {
	out := map[string]string{}
	for _, m := range reAttr.FindAllStringSubmatch(tag, -1) {
		v := m[3] + m[4] + m[5]
		out[strings.ToLower(m[1])] = html.UnescapeString(v)
	}
	return out
}

func clean(s string, max int) string {
	s = strings.TrimSpace(reSpaces.ReplaceAllString(html.UnescapeString(s), " "))
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "")
	}
	if r := []rune(s); len(r) > max {
		s = string(r[:max]) + "…"
	}
	return s
}

// parsePreview extracts title, description, site name and icon from HTML.
func parsePreview(base *url.URL, doc string) LinkPreview {
	p := LinkPreview{URL: base.String()}
	meta := map[string]string{}
	for _, tag := range reMeta.FindAllString(doc, -1) {
		a := attrs(tag)
		key := strings.ToLower(a["property"])
		if key == "" {
			key = strings.ToLower(a["name"])
		}
		if key != "" && a["content"] != "" {
			if _, ok := meta[key]; !ok {
				meta[key] = a["content"]
			}
		}
	}
	if m := reTitle.FindStringSubmatch(doc); m != nil {
		p.Title = clean(m[1], 200)
	}
	if p.Title == "" {
		p.Title = clean(meta["og:title"], 200)
	}
	p.Description = clean(firstNonEmpty(meta["description"], meta["og:description"]), 300)
	p.SiteName = clean(meta["og:site_name"], 80)
	icon := ""
	for _, tag := range reLink.FindAllString(doc, -1) {
		a := attrs(tag)
		rel := strings.ToLower(a["rel"])
		if strings.Contains(rel, "icon") && a["href"] != "" {
			icon = a["href"]
			if rel == "icon" || rel == "shortcut icon" {
				break
			}
		}
	}
	if icon == "" {
		icon = "/favicon.ico"
	}
	if u, err := base.Parse(icon); err == nil && (u.Scheme == "http" || u.Scheme == "https") {
		p.Icon = u.String()
	}
	return p
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}

// fetchPreview downloads at most previewMaxBytes of an HTML page.
func fetchPreview(ctx context.Context, client *http.Client, raw string) (LinkPreview, error) {
	if len(raw) > previewMaxURL {
		return LinkPreview{}, errors.New("url too long")
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return LinkPreview{}, errors.New("bad url")
	}
	ctx, cancel := context.WithTimeout(ctx, previewTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return LinkPreview{}, err
	}
	req.Header.Set("User-Agent", "JiangeLinkPreview/1.0")
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	res, err := client.Do(req)
	if err != nil {
		return LinkPreview{}, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return LinkPreview{}, errors.New("bad status")
	}
	ct := strings.ToLower(res.Header.Get("Content-Type"))
	if ct != "" && !strings.Contains(ct, "text/html") && !strings.Contains(ct, "application/xhtml") {
		return LinkPreview{URL: res.Request.URL.String(), Title: res.Request.URL.Hostname()}, nil
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, previewMaxBytes))
	if err != nil {
		return LinkPreview{}, err
	}
	return parsePreview(res.Request.URL, string(body)), nil
}

func (s *Server) linkPreview(w http.ResponseWriter, r *http.Request) {
	allow := publicAddr
	if s.PreviewAllow != nil {
		allow = s.PreviewAllow
	}
	p, err := fetchPreview(r.Context(), previewClient(allow), r.URL.Query().Get("url"))
	if err != nil {
		httpx.Error(w, http.StatusBadGateway, "preview_failed", "无法获取网页信息")
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=600")
	httpx.JSON(w, http.StatusOK, p)
}
