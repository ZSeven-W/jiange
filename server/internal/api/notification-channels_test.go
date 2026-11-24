package api

import (
	"bufio"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func newNotifChannelTestServer(t *testing.T, st store.Store, configure func(*Server)) (*Server, *httptest.Server) {
	t.Helper()
	s := &Server{
		Store:      st,
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL: time.Hour,
		Iterations: 1000,
	}
	if configure != nil {
		configure(s)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/auth/register", s.register)
	mux.HandleFunc("POST /api/auth/login", s.login)
	mux.Handle("GET /api/me", s.requireUser(http.HandlerFunc(s.me)))
	mux.Handle("POST /api/docs", s.requireUser(http.HandlerFunc(s.createDoc)))
	mux.Handle("POST /api/docs/{id}/comments", s.requireUser(http.HandlerFunc(s.addComment)))

	// Wire notification channel endpoints locally so tests exercise full HTTP contract before api.go wiring.
	mux.Handle("GET /api/workspaces/{wsId}/notification-channels", s.requireUser(http.HandlerFunc(s.listNotificationChannels)))
	mux.Handle("POST /api/workspaces/{wsId}/notification-channels", s.requireUser(http.HandlerFunc(s.createNotificationChannel)))
	mux.Handle("PATCH /api/workspaces/{wsId}/notification-channels/{cid}", s.requireUser(http.HandlerFunc(s.updateNotificationChannel)))
	mux.Handle("DELETE /api/workspaces/{wsId}/notification-channels/{cid}", s.requireUser(http.HandlerFunc(s.deleteNotificationChannel)))
	mux.Handle("POST /api/workspaces/{wsId}/notification-channels/{cid}/test", s.requireUser(http.HandlerFunc(s.testNotificationChannel)))

	handler := httpx.Chain(mux,
		httpx.WithRequestID,
		httpx.Logger(s.Log),
		httpx.Recover(s.Log),
		httpx.SecurityHeaders,
		httpx.RequireJSON,
	)
	ts := httptest.NewServer(handler)
	t.Cleanup(ts.Close)
	return s, ts
}

func TestNotificationChannelSealAndWorkspaceAAD(t *testing.T) {
	s := &Server{AISecret: AISecretFromEnv("notif-channel-test-secret")}
	key := s.notifChannelSecretKey()
	plain := []byte(`{"webhookUrl":"https://open.feishu.cn/open-apis/bot/v2/hook/secret-token","secret":"sign-key"}`)
	sealed, err := sealNotifChannelConfig(key, 42, plain)
	if err != nil {
		t.Fatal(err)
	}
	opened, err := openNotifChannelConfig(key, 42, sealed)
	if err != nil || string(opened) != string(plain) {
		t.Fatalf("open = %q err=%v", opened, err)
	}
	if _, err := openNotifChannelConfig(key, 43, sealed); err == nil {
		t.Fatalf("expected AAD mismatch across workspaces")
	}
}

func TestNotificationChannelCRUDPermissionsAndAudit(t *testing.T) {
	mem := store.NewMemory()
	_, ts := newNotifChannelTestServer(t, mem, func(s *Server) {
		s.AISecret = AISecretFromEnv("prod-notif-key")
	})

	ownerClient := newSSOCookieClient(false)
	memberClient := newSSOCookieClient(false)
	anonClient := newSSOCookieClient(false)

	regOwner := post(t, ownerClient, ts.URL+"/api/auth/register", map[string]string{
		"email": "nc-api-owner@corp.example.com", "name": "Owner", "password": "password123",
	})
	var ownerMe meResponse
	_ = json.NewDecoder(regOwner.Body).Decode(&ownerMe)
	wsID := ownerMe.Workspaces[0].ID

	regMem := post(t, memberClient, ts.URL+"/api/auth/register", map[string]string{
		"email": "nc-api-member@corp.example.com", "name": "Member", "password": "password123",
	})
	var memMe meResponse
	_ = json.NewDecoder(regMem.Body).Decode(&memMe)
	if err := mem.AddWorkspaceMember(t.Context(), wsID, memMe.User.ID); err != nil {
		t.Fatal(err)
	}

	baseURL := fmt.Sprintf("%s/api/workspaces/%d/notification-channels", ts.URL, wsID)

	// Unauthenticated & regular member rejected.
	if res := doJSONReq(t, anonClient, http.MethodGet, baseURL, nil); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anon list = %d, want 401", res.StatusCode)
	}
	if res := doJSONReq(t, memberClient, http.MethodGet, baseURL, nil); res.StatusCode != http.StatusForbidden {
		t.Fatalf("member list = %d, want 403", res.StatusCode)
	}
	if res := doJSONReq(t, memberClient, http.MethodPost, baseURL, map[string]any{
		"name": "Blocked", "kind": "slack_bot",
		"config": map[string]any{"webhookUrl": "https://hooks.slack.com/services/T00/B00/XXXX"},
		"events": []string{"mention"},
	}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("member create = %d, want 403", res.StatusCode)
	}

	// SSRF validation rejects private IPs and localhost for bots & SMTP.
	for _, bad := range []map[string]any{
		{"name": "Bad Bot HTTP", "kind": "feishu_bot", "config": map[string]any{"webhookUrl": "http://open.feishu.cn/hook/abc"}, "events": []string{"mention"}},
		{"name": "Bad Bot Loopback", "kind": "slack_bot", "config": map[string]any{"webhookUrl": "https://127.0.0.1/hook"}, "events": []string{"mention"}},
		{"name": "Bad SMTP Localhost", "kind": "smtp", "config": map[string]any{"host": "localhost", "port": 587, "from": "a@example.com", "to": []string{"b@example.com"}}, "events": []string{"mention"}},
		{"name": "Bad SMTP Private IP", "kind": "smtp", "config": map[string]any{"host": "10.0.0.10", "port": 587, "from": "a@example.com", "to": []string{"b@example.com"}}, "events": []string{"mention"}},
	} {
		if res := doJSONReq(t, ownerClient, http.MethodPost, baseURL, bad); res.StatusCode != http.StatusBadRequest {
			t.Fatalf("bad config %q status = %d, want 400", bad["name"], res.StatusCode)
		}
	}

	// Create SMTP channel and verify plaintext password is NEVER leaked.
	createRes := doJSONReq(t, ownerClient, http.MethodPost, baseURL, map[string]any{
		"name": "企业邮件告警",
		"kind": "smtp",
		"config": map[string]any{
			"host":     "smtp.corp.example.com",
			"port":     587,
			"username": "notifier@corp.example.com",
			"password": "super-secret-smtp-password",
			"from":     "notifier@corp.example.com",
			"to":       []string{"alice@corp.example.com", "bob@corp.example.com"},
			"useTLS":   true,
		},
		"events": []string{"mention", "automation"},
	})
	if createRes.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(createRes.Body)
		t.Fatalf("create smtp status=%d body=%s", createRes.StatusCode, body)
	}
	createBody, _ := io.ReadAll(createRes.Body)
	if strings.Contains(string(createBody), "super-secret-smtp-password") {
		t.Fatalf("plaintext SMTP password leaked in create response: %s", createBody)
	}
	var createOut struct {
		Channel store.NotificationChannel `json:"channel"`
	}
	if err := json.Unmarshal(createBody, &createOut); err != nil {
		t.Fatal(err)
	}
	ch := createOut.Channel
	if ch.ID <= 0 || ch.Kind != "smtp" || !strings.Contains(ch.ConfigHint, "smtp.corp.example.com:587") {
		t.Fatalf("unexpected created channel: %+v", ch)
	}

	// PATCH channel name + events without config preserves sealed SMTP password.
	patchURL := fmt.Sprintf("%s/%d", baseURL, ch.ID)
	patchRes := doJSONReq(t, ownerClient, http.MethodPatch, patchURL, map[string]any{
		"name":    "核心邮件通知",
		"events":  []string{"mention", "comment_reply", "share_updated"},
		"enabled": false,
	})
	if patchRes.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(patchRes.Body)
		t.Fatalf("patch status=%d body=%s", patchRes.StatusCode, body)
	}

	// PATCH config with empty password preserves previous password while updating recipients.
	patchCfgRes := doJSONReq(t, ownerClient, http.MethodPatch, patchURL, map[string]any{
		"config": map[string]any{
			"host":     "smtp.corp.example.com",
			"port":     465,
			"username": "notifier@corp.example.com",
			"password": "",
			"from":     "notifier@corp.example.com",
			"to":       []string{"carol@corp.example.com"},
			"useTLS":   true,
		},
		"enabled": true,
	})
	if patchCfgRes.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(patchCfgRes.Body)
		t.Fatalf("patch config status=%d body=%s", patchCfgRes.StatusCode, body)
	}

	// List returns masked configHint only.
	listRes := doJSONReq(t, ownerClient, http.MethodGet, baseURL, nil)
	if listRes.StatusCode != http.StatusOK {
		t.Fatalf("list status=%d", listRes.StatusCode)
	}
	listRaw, _ := io.ReadAll(listRes.Body)
	if strings.Contains(string(listRaw), "super-secret-smtp-password") {
		t.Fatalf("plaintext SMTP password leaked in list response")
	}
	var listOut struct {
		Channels []store.NotificationChannel `json:"channels"`
	}
	if err := json.Unmarshal(listRaw, &listOut); err != nil || len(listOut.Channels) != 1 {
		t.Fatalf("list decode: %v %+v", err, listOut)
	}
	if !strings.Contains(listOut.Channels[0].ConfigHint, ":465") {
		t.Fatalf("expected updated configHint with :465, got %q", listOut.Channels[0].ConfigHint)
	}

	// Delete channel.
	delRes := doJSONReq(t, ownerClient, http.MethodDelete, patchURL, nil)
	if delRes.StatusCode != http.StatusNoContent {
		t.Fatalf("delete status=%d, want 204", delRes.StatusCode)
	}

	// Verify audit logs captured create / update / delete.
	guard := store.RestoreGuard{UserID: ownerMe.User.ID, SessionHash: []byte("audit-check"), Now: time.Now}
	_ = mem.CreateSession(t.Context(), guard.SessionHash, ownerMe.User.ID, time.Now().Add(time.Hour))
	auditPage, err := mem.ListAuditLogsGuarded(t.Context(), guard, wsID, store.AuditLogFilter{WorkspaceID: wsID})
	if err != nil {
		t.Fatal(err)
	}
	actions := map[string]bool{}
	for _, entry := range auditPage.Items {
		actions[entry.Action] = true
	}
	for _, want := range []string{"notification_channel.create", "notification_channel.update", "notification_channel.delete"} {
		if !actions[want] {
			t.Fatalf("missing expected audit action %q in %+v", want, actions)
		}
	}
}

type fakeSMTPTranscript struct {
	mu       sync.Mutex
	mailFrom string
	rcptTo   []string
	authLine string
	data     string
}

func startFakeSMTPServer(t *testing.T) (addr string, tr *fakeSMTPTranscript) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	tr = &fakeSMTPTranscript{}

	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				r := bufio.NewReader(c)
				w := bufio.NewWriter(c)
				writeLine := func(s string) {
					_, _ = w.WriteString(s + "\r\n")
					_ = w.Flush()
				}
				writeLine("220 fake-smtp.local ESMTP ready")
				for {
					line, err := r.ReadString('\n')
					if err != nil {
						return
					}
					trimmed := strings.TrimRight(line, "\r\n")
					upper := strings.ToUpper(trimmed)
					switch {
					case strings.HasPrefix(upper, "EHLO") || strings.HasPrefix(upper, "HELO"):
						writeLine("250-fake-smtp.local")
						writeLine("250 AUTH PLAIN")
					case strings.HasPrefix(upper, "AUTH PLAIN"):
						tr.mu.Lock()
						tr.authLine = trimmed
						tr.mu.Unlock()
						writeLine("235 Authentication succeeded")
					case strings.HasPrefix(upper, "MAIL FROM:"):
						tr.mu.Lock()
						tr.mailFrom = trimmed
						tr.mu.Unlock()
						writeLine("250 OK")
					case strings.HasPrefix(upper, "RCPT TO:"):
						tr.mu.Lock()
						tr.rcptTo = append(tr.rcptTo, trimmed)
						tr.mu.Unlock()
						writeLine("250 OK")
					case upper == "DATA":
						writeLine("354 End data with <CR><LF>.<CR><LF>")
						var body strings.Builder
						for {
							dline, derr := r.ReadString('\n')
							if derr != nil {
								return
							}
							if strings.TrimRight(dline, "\r\n") == "." {
								break
							}
							body.WriteString(dline)
						}
						tr.mu.Lock()
						tr.data = body.String()
						tr.mu.Unlock()
						writeLine("250 Queued")
					case upper == "QUIT":
						writeLine("221 Bye")
						return
					default:
						writeLine("250 OK")
					}
				}
			}(conn)
		}
	}()
	return ln.Addr().String(), tr
}

func TestNotificationChannelBotAndSMTPDelivery(t *testing.T) {
	// Start local mock bot webhook receiver capturing each bot kind's payload & query.
	type capturedReq struct {
		path  string
		query url.Values
		body  map[string]any
	}
	var mu sync.Mutex
	captured := map[string]capturedReq{}
	botServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		mu.Lock()
		captured[r.URL.Path] = capturedReq{path: r.URL.Path, query: r.URL.Query(), body: m}
		mu.Unlock()
		switch r.URL.Path {
		case "/feishu":
			_, _ = w.Write([]byte(`{"code":0,"msg":"success"}`))
		case "/dingtalk":
			_, _ = w.Write([]byte(`{"errcode":0,"errmsg":"ok"}`))
		case "/wecom":
			_, _ = w.Write([]byte(`{"errcode":0,"errmsg":"ok"}`))
		case "/slack":
			_, _ = w.Write([]byte(`ok`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer botServer.Close()

	// Start real local fake SMTP server and inject dialer.
	smtpAddr, smtpTr := startFakeSMTPServer(t)
	smtpHost, smtpPortStr, _ := net.SplitHostPort(smtpAddr)
	var smtpPort int
	_, _ = fmt.Sscanf(smtpPortStr, "%d", &smtpPort)
	setNotifChannelSMTPDialer(func(ctx context.Context, addr string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "tcp", addr)
	})
	t.Cleanup(func() { setNotifChannelSMTPDialer(nil) })

	fixedTime := time.Date(2026, 11, 24, 10, 0, 0, 0, time.UTC)
	mem := store.NewMemory()
	_, ts := newNotifChannelTestServer(t, mem, func(s *Server) {
		s.AISecret = AISecretFromEnv("delivery-test-secret")
		s.WebhookAllowHTTP = true
		s.WebhookTransport = botServer.Client().Transport
		s.Now = func() time.Time { return fixedTime }
	})

	ownerClient := newSSOCookieClient(false)
	regOwner := post(t, ownerClient, ts.URL+"/api/auth/register", map[string]string{
		"email": "deliver-owner@corp.example.com", "name": "Deliver Owner", "password": "password123",
	})
	var ownerMe meResponse
	_ = json.NewDecoder(regOwner.Body).Decode(&ownerMe)
	wsID := ownerMe.Workspaces[0].ID
	baseURL := fmt.Sprintf("%s/api/workspaces/%d/notification-channels", ts.URL, wsID)

	createAndTest := func(name, kind string, cfg map[string]any) store.NotificationChannel {
		t.Helper()
		res := doJSONReq(t, ownerClient, http.MethodPost, baseURL, map[string]any{
			"name":   name,
			"kind":   kind,
			"config": cfg,
			"events": []string{"mention"},
		})
		if res.StatusCode != http.StatusCreated {
			body, _ := io.ReadAll(res.Body)
			t.Fatalf("create %s status=%d body=%s", kind, res.StatusCode, body)
		}
		var out struct {
			Channel store.NotificationChannel `json:"channel"`
		}
		_ = json.NewDecoder(res.Body).Decode(&out)

		testRes := doJSONReq(t, ownerClient, http.MethodPost, fmt.Sprintf("%s/%d/test", baseURL, out.Channel.ID), map[string]any{})
		if testRes.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(testRes.Body)
			t.Fatalf("test %s status=%d body=%s", kind, testRes.StatusCode, body)
		}
		var testOut struct {
			OK      bool                      `json:"ok"`
			Status  string                    `json:"status"`
			Error   string                    `json:"error"`
			Channel store.NotificationChannel `json:"channel"`
		}
		_ = json.NewDecoder(testRes.Body).Decode(&testOut)
		if !testOut.OK || testOut.Status != "ok" || testOut.Error != "" {
			t.Fatalf("test %s failed: %+v", kind, testOut)
		}
		if testOut.Channel.LastStatus != "ok" || testOut.Channel.LastSentAt == nil {
			t.Fatalf("test %s did not update channel delivery status: %+v", kind, testOut.Channel)
		}
		return testOut.Channel
	}

	// 1. Feishu bot with HMAC-SHA256 signature.
	createAndTest("飞书群", "feishu_bot", map[string]any{
		"webhookUrl": botServer.URL + "/feishu",
		"secret":     "feishu-sign-secret",
	})
	mu.Lock()
	feishuReq := captured["/feishu"]
	mu.Unlock()
	if feishuReq.body["msg_type"] != "interactive" {
		t.Fatalf("feishu msg_type = %v, want interactive", feishuReq.body["msg_type"])
	}
	wantFeishuTS, wantFeishuSign := feishuBotSign("feishu-sign-secret", fixedTime.Unix())
	if feishuReq.body["timestamp"] != wantFeishuTS || feishuReq.body["sign"] != wantFeishuSign {
		t.Fatalf("feishu signature mismatch: got (%v,%v) want (%s,%s)", feishuReq.body["timestamp"], feishuReq.body["sign"], wantFeishuTS, wantFeishuSign)
	}

	// 2. DingTalk bot with HMAC-SHA256 query signature.
	createAndTest("钉钉群", "dingtalk_bot", map[string]any{
		"webhookUrl": botServer.URL + "/dingtalk?access_token=tok123",
		"secret":     "SEC-dingtalk-secret",
	})
	mu.Lock()
	dtReq := captured["/dingtalk"]
	mu.Unlock()
	if dtReq.body["msgtype"] != "markdown" {
		t.Fatalf("dingtalk msgtype = %v, want markdown", dtReq.body["msgtype"])
	}
	wantTS := fmt.Sprintf("%d", fixedTime.UnixMilli())
	mac := hmac.New(sha256.New, []byte("SEC-dingtalk-secret"))
	mac.Write([]byte(wantTS + "\nSEC-dingtalk-secret"))
	wantSign := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if dtReq.query.Get("timestamp") != wantTS || dtReq.query.Get("sign") != wantSign {
		t.Fatalf("dingtalk query signature mismatch: got (%q,%q) want (%q,%q)", dtReq.query.Get("timestamp"), dtReq.query.Get("sign"), wantTS, wantSign)
	}

	// 3. WeCom bot.
	createAndTest("企微群", "wecom_bot", map[string]any{
		"webhookUrl": botServer.URL + "/wecom?key=abc",
	})
	mu.Lock()
	wecomReq := captured["/wecom"]
	mu.Unlock()
	if wecomReq.body["msgtype"] != "markdown" {
		t.Fatalf("wecom msgtype = %v, want markdown", wecomReq.body["msgtype"])
	}

	// 4. Slack bot.
	createAndTest("Slack 频道", "slack_bot", map[string]any{
		"webhookUrl": botServer.URL + "/slack",
	})
	mu.Lock()
	slackReq := captured["/slack"]
	mu.Unlock()
	if _, ok := slackReq.body["blocks"]; !ok || !strings.Contains(fmt.Sprint(slackReq.body["text"]), notifChannelTestTitle) {
		t.Fatalf("slack payload unexpected: %+v", slackReq.body)
	}

	// 5. SMTP email over fake TCP SMTP server.
	createAndTest("运维邮件", "smtp", map[string]any{
		"host":     smtpHost,
		"port":     smtpPort,
		"username": "bot@corp.example.com",
		"password": "smtp-test-password",
		"from":     "bot@corp.example.com",
		"to":       []string{"alice@corp.example.com", "bob@corp.example.com"},
		"useTLS":   false,
	})
	smtpTr.mu.Lock()
	defer smtpTr.mu.Unlock()
	if !strings.Contains(smtpTr.mailFrom, "bot@corp.example.com") || len(smtpTr.rcptTo) != 2 {
		t.Fatalf("unexpected SMTP envelope: from=%q rcpt=%v", smtpTr.mailFrom, smtpTr.rcptTo)
	}
	if smtpTr.authLine == "" {
		t.Fatalf("expected SMTP AUTH PLAIN to be sent")
	}
	expectedSubj := mime.BEncoding.Encode("utf-8", notifChannelTestTitle)
	if !strings.Contains(smtpTr.data, "Subject: "+expectedSubj) {
		t.Fatalf("expected MIME UTF-8 subject %q in SMTP data:\n%s", expectedSubj, smtpTr.data)
	}
	if !strings.Contains(smtpTr.data, `Content-Type: text/plain; charset="UTF-8"`) {
		t.Fatalf("expected UTF-8 Content-Type in SMTP data")
	}
}

func TestNotificationChannelHooksOnCommentAndAutomation(t *testing.T) {
	receivedCh := make(chan string, 10)
	botServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		receivedCh <- r.URL.Path + ":" + string(raw)
		_, _ = w.Write([]byte(`ok`))
	}))
	defer botServer.Close()

	mem := store.NewMemory()
	srv, ts := newNotifChannelTestServer(t, mem, func(s *Server) {
		s.AISecret = AISecretFromEnv("hook-test-secret")
		s.WebhookAllowHTTP = true
		s.WebhookTransport = botServer.Client().Transport
	})

	ownerClient := newSSOCookieClient(false)
	memberClient := newSSOCookieClient(false)
	regOwner := post(t, ownerClient, ts.URL+"/api/auth/register", map[string]string{
		"email": "hook-owner@corp.example.com", "name": "Alice", "password": "password123",
	})
	var ownerMe meResponse
	_ = json.NewDecoder(regOwner.Body).Decode(&ownerMe)
	wsID := ownerMe.Workspaces[0].ID

	regMem := post(t, memberClient, ts.URL+"/api/auth/register", map[string]string{
		"email": "hook-member@corp.example.com", "name": "Bob", "password": "password123",
	})
	var memMe meResponse
	_ = json.NewDecoder(regMem.Body).Decode(&memMe)
	if err := mem.AddWorkspaceMember(t.Context(), wsID, memMe.User.ID); err != nil {
		t.Fatal(err)
	}

	baseURL := fmt.Sprintf("%s/api/workspaces/%d/notification-channels", ts.URL, wsID)
	for _, spec := range []struct {
		name  string
		path  string
		event string
	}{
		{"Mention Slack", "/mention", "mention"},
		{"Reply Slack", "/reply", "comment_reply"},
		{"Auto Slack", "/auto", "automation"},
	} {
		res := doJSONReq(t, ownerClient, http.MethodPost, baseURL, map[string]any{
			"name":   spec.name,
			"kind":   "slack_bot",
			"config": map[string]any{"webhookUrl": botServer.URL + spec.path},
			"events": []string{spec.event},
		})
		if res.StatusCode != http.StatusCreated {
			t.Fatalf("create %s: %d", spec.name, res.StatusCode)
		}
	}

	// Create a doc and post a comment mentioning Bob -> triggers "mention" channel.
	docRes := doJSONReq(t, ownerClient, http.MethodPost, ts.URL+"/api/docs", map[string]any{
		"workspaceId": wsID,
		"title":       "季度 OKR 复盘",
	})
	var createdDoc store.DocMeta
	_ = json.NewDecoder(docRes.Body).Decode(&createdDoc)

	cRes := doJSONReq(t, ownerClient, http.MethodPost, fmt.Sprintf("%s/api/docs/%d/comments", ts.URL, createdDoc.ID), map[string]any{
		"body":     "请 @Bob 确认第三季度指标",
		"mentions": []int64{memMe.User.ID},
	})
	if cRes.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(cRes.Body)
		t.Fatalf("add mention comment status=%d body=%s", cRes.StatusCode, body)
	}
	var firstComment store.Comment
	_ = json.NewDecoder(cRes.Body).Decode(&firstComment)

	select {
	case msg := <-receivedCh:
		if !strings.HasPrefix(msg, "/mention:") || !strings.Contains(msg, "季度 OKR 复盘") {
			t.Fatalf("unexpected mention dispatch: %s", msg)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for mention channel dispatch")
	}

	// Bob replies to Alice's comment -> triggers "comment_reply" channel.
	replyRes := doJSONReq(t, memberClient, http.MethodPost, fmt.Sprintf("%s/api/docs/%d/comments", ts.URL, createdDoc.ID), map[string]any{
		"parentId": firstComment.ID,
		"body":     "已确认无误！",
	})
	if replyRes.StatusCode != http.StatusCreated {
		t.Fatalf("add reply comment status=%d", replyRes.StatusCode)
	}
	select {
	case msg := <-receivedCh:
		if !strings.HasPrefix(msg, "/reply:") || !strings.Contains(msg, "已确认无误") {
			t.Fatalf("unexpected reply dispatch: %s", msg)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for comment_reply channel dispatch")
	}

	// Fire a base automation -> triggers "automation" channel.
	baseDoc, err := mem.CreateBase(t.Context(), wsID, ownerMe.User.ID, nil, "客户线索表")
	if err != nil {
		t.Fatal(err)
	}
	srv.fireAutomation(t.Context(), baseDoc.ID, "高意向客户提醒", automationConfig{
		Message: "收到新的高意向线索！",
	}, nil, store.Record{ID: 1, BaseID: baseDoc.ID}, ownerMe.User.ID)

	select {
	case msg := <-receivedCh:
		if !strings.HasPrefix(msg, "/auto:") || !strings.Contains(msg, "高意向客户提醒") || !strings.Contains(msg, "收到新的高意向线索") {
			t.Fatalf("unexpected automation dispatch: %s", msg)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for automation channel dispatch")
	}
}
