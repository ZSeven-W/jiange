package api

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/mail"
	"net/netip"
	"net/smtp"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

const (
	notifChannelDevSecretSeed    = "jiange-dev-notif-channel-secret"
	notifChannelDispatchBudget   = 10 * time.Second
	notifChannelSMTPTimeout      = 8 * time.Second
	notifChannelMaxSecretLen     = 256
	notifChannelMaxRecipients    = 20
	notifChannelMaxRespReadBytes = 2048

	notifChannelTestTitle = "【Jiange 简格】外部通知渠道连通性测试"
	notifChannelTestBody  = "这是一条来自 Jiange 简格工作空间的测试通知，用于验证当前外部通知渠道的配置与连通性是否正常。"
)

// smtpChannelConfig is the sealed JSON structure for kind == "smtp".
type smtpChannelConfig struct {
	Host     string   `json:"host"`
	Port     int      `json:"port"`
	Username string   `json:"username,omitempty"`
	Password string   `json:"password,omitempty"`
	From     string   `json:"from"`
	To       []string `json:"to"`
	UseTLS   *bool    `json:"useTLS,omitempty"`
}

// botChannelConfig is the sealed JSON structure for feishu_bot / dingtalk_bot / wecom_bot / slack_bot.
type botChannelConfig struct {
	WebhookURL string `json:"webhookUrl"`
	Secret     string `json:"secret,omitempty"`
}

// Injectable test hooks for SMTP dialing/delivery (protected by mutex for concurrent tests).
var (
	notifChannelSMTPMu     sync.RWMutex
	notifChannelSMTPDialer func(ctx context.Context, addr string) (net.Conn, error)
)

func setNotifChannelSMTPDialer(fn func(ctx context.Context, addr string) (net.Conn, error)) {
	notifChannelSMTPMu.Lock()
	notifChannelSMTPDialer = fn
	notifChannelSMTPMu.Unlock()
}

func getNotifChannelSMTPDialer() func(ctx context.Context, addr string) (net.Conn, error) {
	notifChannelSMTPMu.RLock()
	fn := notifChannelSMTPDialer
	notifChannelSMTPMu.RUnlock()
	return fn
}

func (s *Server) notificationChannelStore() (store.NotificationChannelStore, bool) {
	st, ok := s.Store.(store.NotificationChannelStore)
	return st, ok
}

func (s *Server) notifChannelSecretKey() []byte {
	if len(s.AISecret) > 0 {
		h := sha256.New()
		h.Write([]byte("jiange-notif-channel-key:"))
		h.Write(s.AISecret)
		return h.Sum(nil)
	}
	sum := sha256.Sum256([]byte(notifChannelDevSecretSeed))
	return sum[:]
}

func notifChannelAAD(workspaceID int64) []byte {
	return []byte("jiange-notif-channel:" + strconv.FormatInt(workspaceID, 10))
}

func sealNotifChannelConfig(key []byte, workspaceID int64, plain []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, plain, notifChannelAAD(workspaceID)), nil
}

func openNotifChannelConfig(key []byte, workspaceID int64, sealed []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(sealed) < gcm.NonceSize() {
		return nil, errors.New("short ciphertext")
	}
	return gcm.Open(nil, sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():], notifChannelAAD(workspaceID))
}

func containsHeaderCRLF(s string) bool {
	return strings.ContainsAny(s, "\r\n\x00")
}

func maskEmailForHint(addr string) string {
	local, domain, ok := strings.Cut(addr, "@")
	if !ok || local == "" || domain == "" {
		return "***"
	}
	runes := []rune(local)
	if len(runes) <= 1 {
		return string(runes) + "***@" + domain
	}
	if len(runes) == 2 {
		return string(runes[:1]) + "***@" + domain
	}
	return string(runes[:2]) + "***@" + domain
}

func maskWebhookURLForHint(rawURL string, hasSecret bool) string {
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" {
		return "https://***"
	}
	tail := ""
	pathTrimmed := strings.TrimRight(u.Path, "/")
	if len(pathTrimmed) >= 4 {
		tail = pathTrimmed[len(pathTrimmed)-4:]
	} else if q := u.RawQuery; len(q) >= 4 {
		tail = q[len(q)-4:]
	}
	hint := u.Host + "/..." + tail
	if hasSecret {
		hint += " (已加签)"
	}
	return hint
}

func buildSMTPConfigHint(cfg smtpChannelConfig) string {
	first := ""
	if len(cfg.To) > 0 {
		first = maskEmailForHint(cfg.To[0])
	}
	if len(cfg.To) > 1 {
		return fmt.Sprintf("%s:%d -> %s (+%d)", cfg.Host, cfg.Port, first, len(cfg.To)-1)
	}
	return fmt.Sprintf("%s:%d -> %s", cfg.Host, cfg.Port, first)
}

func (s *Server) validateSMTPHost(raw string) (string, error) {
	host := strings.TrimSpace(raw)
	if host == "" || len(host) > 255 || containsHeaderCRLF(host) || strings.ContainsAny(host, " \t/:@?#") {
		return "", errors.New("SMTP 服务器地址无效")
	}
	lower := strings.ToLower(host)
	enforceSSRF := getNotifChannelSMTPDialer() == nil && !s.WebhookAllowHTTP && s.PreviewAllow == nil
	if enforceSSRF && (lower == "localhost" || strings.HasSuffix(lower, ".localhost")) {
		return "", errors.New("SMTP 服务器地址不允许使用本地回环地址")
	}
	if ip, err := netip.ParseAddr(host); err == nil {
		allow := publicAddr
		if s.PreviewAllow != nil {
			allow = s.PreviewAllow
		}
		if getNotifChannelSMTPDialer() == nil && !s.WebhookAllowHTTP && !allow(ip) {
			return "", errors.New("SMTP 服务器地址不允许使用内网或保留 IP")
		}
	}
	return host, nil
}

func parseCleanEmailAddress(raw string) (string, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || len(trimmed) > 320 || containsHeaderCRLF(trimmed) {
		return "", false
	}
	addr, err := mail.ParseAddress(trimmed)
	if err != nil || addr.Address == "" || containsHeaderCRLF(addr.Address) {
		return "", false
	}
	return addr.Address, true
}

func (s *Server) validateAndSealChannelConfig(wsID int64, kind string, rawConfig json.RawMessage, existingPlain []byte, sameKind bool) ([]byte, string, error) {
	if len(bytes.TrimSpace(rawConfig)) == 0 || string(bytes.TrimSpace(rawConfig)) == "null" {
		return nil, "", errors.New("请填写渠道配置")
	}
	switch kind {
	case store.NotificationChannelKindSMTP:
		var cfg smtpChannelConfig
		if err := json.Unmarshal(rawConfig, &cfg); err != nil {
			return nil, "", errors.New("SMTP 配置格式错误")
		}
		if sameKind && len(existingPlain) > 0 {
			var prev smtpChannelConfig
			if json.Unmarshal(existingPlain, &prev) == nil {
				if strings.TrimSpace(cfg.Password) == "" && prev.Password != "" {
					cfg.Password = prev.Password
				}
				if strings.TrimSpace(cfg.Host) == "" {
					cfg.Host = prev.Host
				}
				if cfg.Port == 0 {
					cfg.Port = prev.Port
				}
				if strings.TrimSpace(cfg.From) == "" {
					cfg.From = prev.From
				}
				if len(cfg.To) == 0 {
					cfg.To = prev.To
				}
				if cfg.UseTLS == nil {
					cfg.UseTLS = prev.UseTLS
				}
			}
		}
		host, err := s.validateSMTPHost(cfg.Host)
		if err != nil {
			return nil, "", err
		}
		cfg.Host = host
		if cfg.Port < 1 || cfg.Port > 65535 {
			return nil, "", errors.New("SMTP 端口需在 1-65535 之间")
		}
		cfg.Username = strings.TrimSpace(cfg.Username)
		if containsHeaderCRLF(cfg.Username) || len(cfg.Username) > 256 {
			return nil, "", errors.New("SMTP 用户名无效")
		}
		if len(cfg.Password) > notifChannelMaxSecretLen {
			return nil, "", errors.New("SMTP 密码长度超出限制")
		}
		fromAddr, ok := parseCleanEmailAddress(cfg.From)
		if !ok {
			return nil, "", errors.New("请填写有效的发件人邮箱地址")
		}
		cfg.From = fromAddr
		if len(cfg.To) == 0 || len(cfg.To) > notifChannelMaxRecipients {
			return nil, "", fmt.Errorf("请填写 1-%d 个收件人邮箱地址", notifChannelMaxRecipients)
		}
		seen := make(map[string]struct{}, len(cfg.To))
		cleanTo := make([]string, 0, len(cfg.To))
		for _, item := range cfg.To {
			addr, ok := parseCleanEmailAddress(item)
			if !ok {
				return nil, "", fmt.Errorf("收件人邮箱无效：%s", strings.TrimSpace(item))
			}
			key := strings.ToLower(addr)
			if _, dup := seen[key]; dup {
				continue
			}
			seen[key] = struct{}{}
			cleanTo = append(cleanTo, addr)
		}
		if len(cleanTo) == 0 {
			return nil, "", errors.New("请至少填写一个有效收件人邮箱")
		}
		cfg.To = cleanTo
		if cfg.UseTLS == nil {
			defaultTLS := true
			cfg.UseTLS = &defaultTLS
		}
		plain, err := json.Marshal(cfg)
		if err != nil {
			return nil, "", err
		}
		sealed, err := sealNotifChannelConfig(s.notifChannelSecretKey(), wsID, plain)
		if err != nil {
			return nil, "", err
		}
		return sealed, buildSMTPConfigHint(cfg), nil

	case store.NotificationChannelKindFeishuBot,
		store.NotificationChannelKindDingTalkBot,
		store.NotificationChannelKindWeComBot,
		store.NotificationChannelKindSlackBot:
		var cfg botChannelConfig
		if err := json.Unmarshal(rawConfig, &cfg); err != nil {
			return nil, "", errors.New("机器人 Webhook 配置格式错误")
		}
		if sameKind && len(existingPlain) > 0 {
			var prev botChannelConfig
			if json.Unmarshal(existingPlain, &prev) == nil {
				if strings.TrimSpace(cfg.WebhookURL) == "" {
					cfg.WebhookURL = prev.WebhookURL
				}
				if strings.TrimSpace(cfg.Secret) == "" && prev.Secret != "" {
					cfg.Secret = prev.Secret
				}
			}
		}
		cleanURL, ok := s.validateWebhookTargetURL(cfg.WebhookURL)
		if !ok {
			return nil, "", errors.New("请填写有效的公网 HTTPS 机器人 Webhook 地址")
		}
		cfg.WebhookURL = cleanURL
		cfg.Secret = strings.TrimSpace(cfg.Secret)
		if kind == store.NotificationChannelKindWeComBot || kind == store.NotificationChannelKindSlackBot {
			cfg.Secret = ""
		} else if len(cfg.Secret) > notifChannelMaxSecretLen {
			return nil, "", errors.New("加签密钥长度超出限制")
		}
		plain, err := json.Marshal(cfg)
		if err != nil {
			return nil, "", err
		}
		sealed, err := sealNotifChannelConfig(s.notifChannelSecretKey(), wsID, plain)
		if err != nil {
			return nil, "", err
		}
		return sealed, maskWebhookURLForHint(cfg.WebhookURL, cfg.Secret != ""), nil

	default:
		return nil, "", errors.New("不支持的通知渠道类型")
	}
}

// --- Outbound delivery implementations ---

type flexiblePlainAuth struct {
	username string
	password string
	host     string
	allowRaw bool
}

func (a *flexiblePlainAuth) Start(server *smtp.ServerInfo) (string, []byte, error) {
	if !server.TLS && !a.allowRaw && server.Name != "localhost" && server.Name != "127.0.0.1" && server.Name != "::1" {
		return "", nil, errors.New("unencrypted connection")
	}
	resp := []byte("\x00" + a.username + "\x00" + a.password)
	return "PLAIN", resp, nil
}

func (a *flexiblePlainAuth) Next(fromServer []byte, more bool) ([]byte, error) {
	if more {
		return nil, errors.New("unexpected SMTP server challenge")
	}
	return nil, nil
}

func buildMIMEUTF8Email(from string, to []string, subject, body string, now time.Time) []byte {
	cleanSubject := strings.NewReplacer("\r", " ", "\n", " ").Replace(strings.TrimSpace(subject))
	encodedSubject := mime.BEncoding.Encode("utf-8", cleanSubject)

	var buf bytes.Buffer
	buf.WriteString("From: " + from + "\r\n")
	buf.WriteString("To: " + strings.Join(to, ", ") + "\r\n")
	buf.WriteString("Subject: " + encodedSubject + "\r\n")
	buf.WriteString("Date: " + now.UTC().Format(time.RFC1123Z) + "\r\n")
	buf.WriteString("MIME-Version: 1.0\r\n")
	buf.WriteString("Content-Type: text/plain; charset=\"UTF-8\"\r\n")
	buf.WriteString("Content-Transfer-Encoding: base64\r\n")
	buf.WriteString("\r\n")

	encodedBody := base64.StdEncoding.EncodeToString([]byte(body))
	for i := 0; i < len(encodedBody); i += 76 {
		end := i + 76
		if end > len(encodedBody) {
			end = len(encodedBody)
		}
		buf.WriteString(encodedBody[i:end])
		buf.WriteString("\r\n")
	}
	return buf.Bytes()
}

func (s *Server) dialSMTPConn(ctx context.Context, addr string) (net.Conn, error) {
	if custom := getNotifChannelSMTPDialer(); custom != nil {
		return custom(ctx, addr)
	}
	allow := publicAddr
	if s.PreviewAllow != nil {
		allow = s.PreviewAllow
	}
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	if !s.WebhookAllowHTTP || s.PreviewAllow != nil {
		dialer.Control = func(network, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return errBlockedAddress
			}
			ip, err := netip.ParseAddr(host)
			if err != nil || !allow(ip) {
				return errBlockedAddress
			}
			return nil
		}
	}
	return dialer.DialContext(ctx, "tcp", addr)
}

func (s *Server) sendSMTPEmail(ctx context.Context, cfg smtpChannelConfig, title, body, link string) error {
	if _, err := s.validateSMTPHost(cfg.Host); err != nil {
		return err
	}
	sendCtx, cancel := context.WithTimeout(ctx, notifChannelSMTPTimeout)
	defer cancel()

	addr := net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
	conn, err := s.dialSMTPConn(sendCtx, addr)
	if err != nil {
		if errors.Is(err, errBlockedAddress) || strings.Contains(err.Error(), errBlockedAddress.Error()) {
			return errors.New("SMTP target address blocked by SSRF policy")
		}
		return err
	}
	if deadline, ok := sendCtx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}

	useTLS := true
	if cfg.UseTLS != nil {
		useTLS = *cfg.UseTLS
	}

	var client *smtp.Client
	if useTLS && cfg.Port == 465 {
		tlsConn := tls.Client(conn, &tls.Config{
			ServerName: cfg.Host,
			MinVersion: tls.VersionTLS12,
		})
		if err := tlsConn.HandshakeContext(sendCtx); err != nil {
			_ = conn.Close()
			return err
		}
		client, err = smtp.NewClient(tlsConn, cfg.Host)
	} else {
		client, err = smtp.NewClient(conn, cfg.Host)
	}
	if err != nil {
		_ = conn.Close()
		return err
	}
	defer func() {
		_ = client.Close()
	}()

	if !(useTLS && cfg.Port == 465) {
		if ok, _ := client.Extension("STARTTLS"); ok {
			if err := client.StartTLS(&tls.Config{
				ServerName: cfg.Host,
				MinVersion: tls.VersionTLS12,
			}); err != nil {
				return err
			}
		} else if useTLS {
			return errors.New("SMTP server does not support STARTTLS")
		}
	}

	if cfg.Username != "" {
		if ok, _ := client.Extension("AUTH"); ok {
			auth := &flexiblePlainAuth{
				username: cfg.Username,
				password: cfg.Password,
				host:     cfg.Host,
				allowRaw: !useTLS,
			}
			if err := client.Auth(auth); err != nil {
				return err
			}
		}
	}

	if err := client.Mail(cfg.From); err != nil {
		return err
	}
	for _, rcpt := range cfg.To {
		if err := client.Rcpt(rcpt); err != nil {
			return err
		}
	}
	wc, err := client.Data()
	if err != nil {
		return err
	}
	fullBody := body
	if strings.TrimSpace(link) != "" {
		fullBody = strings.TrimSpace(body) + "\n\n链接：" + strings.TrimSpace(link)
	}
	msg := buildMIMEUTF8Email(cfg.From, cfg.To, title, fullBody, s.now())
	if _, err := wc.Write(msg); err != nil {
		_ = wc.Close()
		return err
	}
	if err := wc.Close(); err != nil {
		return err
	}
	_ = client.Quit()
	return nil
}

func feishuBotSign(secret string, tsSec int64) (string, string) {
	tsStr := strconv.FormatInt(tsSec, 10)
	stringToSign := tsStr + "\n" + secret
	mac := hmac.New(sha256.New, []byte(stringToSign))
	return tsStr, base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func dingTalkSignedURL(rawURL, secret string, tsMillis int64) (string, error) {
	if secret == "" {
		return rawURL, nil
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		return "", err
	}
	tsStr := strconv.FormatInt(tsMillis, 10)
	stringToSign := tsStr + "\n" + secret
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(stringToSign))
	sign := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	q := u.Query()
	q.Set("timestamp", tsStr)
	q.Set("sign", sign)
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func clampHeaderRunes(s string, maxRunes int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) <= maxRunes {
		return string(r)
	}
	return string(r[:maxRunes-1]) + "…"
}

func (s *Server) sendBotNotification(ctx context.Context, kind string, cfg botChannelConfig, title, body, link string) error {
	targetURL, ok := s.validateWebhookTargetURL(cfg.WebhookURL)
	if !ok {
		return errors.New("bot webhook target URL rejected by security policy")
	}

	var payload any
	switch kind {
	case store.NotificationChannelKindFeishuBot:
		mdContent := strings.TrimSpace(body)
		if strings.TrimSpace(link) != "" {
			mdContent += fmt.Sprintf("\n\n[查看详情](%s)", strings.TrimSpace(link))
		}
		m := map[string]any{
			"msg_type": "interactive",
			"card": map[string]any{
				"header": map[string]any{
					"template": "blue",
					"title": map[string]any{
						"tag":     "plain_text",
						"content": title,
					},
				},
				"elements": []map[string]any{
					{
						"tag":     "markdown",
						"content": mdContent,
					},
				},
			},
		}
		if cfg.Secret != "" {
			tsStr, sign := feishuBotSign(cfg.Secret, s.now().Unix())
			m["timestamp"] = tsStr
			m["sign"] = sign
		}
		payload = m

	case store.NotificationChannelKindDingTalkBot:
		signedURL, err := dingTalkSignedURL(targetURL, cfg.Secret, s.now().UnixMilli())
		if err != nil {
			return err
		}
		targetURL = signedURL
		mdText := fmt.Sprintf("### %s\n\n%s", title, strings.TrimSpace(body))
		if strings.TrimSpace(link) != "" {
			mdText += fmt.Sprintf("\n\n[查看详情](%s)", strings.TrimSpace(link))
		}
		payload = map[string]any{
			"msgtype": "markdown",
			"markdown": map[string]any{
				"title": title,
				"text":  mdText,
			},
		}

	case store.NotificationChannelKindWeComBot:
		mdContent := fmt.Sprintf("**%s**\n%s", title, strings.TrimSpace(body))
		if strings.TrimSpace(link) != "" {
			mdContent += fmt.Sprintf("\n[查看详情](%s)", strings.TrimSpace(link))
		}
		payload = map[string]any{
			"msgtype": "markdown",
			"markdown": map[string]any{
				"content": mdContent,
			},
		}

	case store.NotificationChannelKindSlackBot:
		sectionText := strings.TrimSpace(body)
		if strings.TrimSpace(link) != "" {
			sectionText += fmt.Sprintf("\n<%s|查看详情>", strings.TrimSpace(link))
		}
		fallback := title
		if strings.TrimSpace(body) != "" {
			fallback = title + " - " + strings.TrimSpace(body)
		}
		payload = map[string]any{
			"text": fallback,
			"blocks": []map[string]any{
				{
					"type": "header",
					"text": map[string]any{
						"type":  "plain_text",
						"text":  clampHeaderRunes(title, 150),
						"emoji": true,
					},
				},
				{
					"type": "section",
					"text": map[string]any{
						"type": "mrkdwn",
						"text": sectionText,
					},
				},
			},
		}

	default:
		return fmt.Errorf("unsupported channel kind: %s", kind)
	}

	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Jiange-Notifier/1.0")

	res, err := s.webhookClient().Do(req)
	if err != nil {
		if errors.Is(err, errBlockedAddress) || strings.Contains(err.Error(), errBlockedAddress.Error()) {
			return errors.New("target address blocked by SSRF policy")
		}
		return err
	}
	defer res.Body.Close()

	respRaw, _ := io.ReadAll(io.LimitReader(res.Body, notifChannelMaxRespReadBytes))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		statusText := strings.TrimSpace(http.StatusText(res.StatusCode))
		if statusText != "" {
			return fmt.Errorf("HTTP %d %s", res.StatusCode, statusText)
		}
		return fmt.Errorf("HTTP %d", res.StatusCode)
	}
	// Parse IM bot API error envelopes (Feishu code/StatusCode, DingTalk/WeCom errcode).
	if len(bytes.TrimSpace(respRaw)) > 0 && bytes.HasPrefix(bytes.TrimSpace(respRaw), []byte("{")) {
		var envelope struct {
			Code       int    `json:"code"`
			StatusCode int    `json:"StatusCode"`
			ErrCode    int    `json:"errcode"`
			Msg        string `json:"msg"`
			StatusMsg  string `json:"StatusMessage"`
			ErrMsg     string `json:"errmsg"`
		}
		if json.Unmarshal(respRaw, &envelope) == nil {
			switch kind {
			case store.NotificationChannelKindFeishuBot:
				if envelope.Code != 0 {
					return fmt.Errorf("feishu error %d: %s", envelope.Code, strings.TrimSpace(envelope.Msg))
				}
				if envelope.StatusCode != 0 {
					return fmt.Errorf("feishu error %d: %s", envelope.StatusCode, strings.TrimSpace(envelope.StatusMsg))
				}
			case store.NotificationChannelKindDingTalkBot, store.NotificationChannelKindWeComBot:
				if envelope.ErrCode != 0 {
					return fmt.Errorf("bot error %d: %s", envelope.ErrCode, strings.TrimSpace(envelope.ErrMsg))
				}
			}
		}
	}
	return nil
}

func (s *Server) deliverNotificationChannel(ctx context.Context, ch store.NotificationChannel, title, body, link string) error {
	plain, err := openNotifChannelConfig(s.notifChannelSecretKey(), ch.WorkspaceID, ch.ConfigEnc)
	if err != nil {
		return errors.New("failed to decrypt channel configuration")
	}
	switch ch.Kind {
	case store.NotificationChannelKindSMTP:
		var cfg smtpChannelConfig
		if err := json.Unmarshal(plain, &cfg); err != nil {
			return errors.New("invalid decrypted SMTP configuration")
		}
		return s.sendSMTPEmail(ctx, cfg, title, body, link)

	case store.NotificationChannelKindFeishuBot,
		store.NotificationChannelKindDingTalkBot,
		store.NotificationChannelKindWeComBot,
		store.NotificationChannelKindSlackBot:
		var cfg botChannelConfig
		if err := json.Unmarshal(plain, &cfg); err != nil {
			return errors.New("invalid decrypted bot configuration")
		}
		return s.sendBotNotification(ctx, ch.Kind, cfg, title, body, link)

	default:
		return fmt.Errorf("unsupported notification channel kind: %s", ch.Kind)
	}
}

// dispatchWorkspaceNotification asynchronously fans out a workspace notification
// to all enabled external notification channels subscribed to event, with a 10s
// total timeout budget and delivery status tracking.
func (s *Server) dispatchWorkspaceNotification(wsID int64, event, title, body, link string) {
	if s == nil || s.Store == nil || wsID <= 0 || !store.IsValidNotificationEvent(event) {
		return
	}
	ns, ok := s.notificationChannelStore()
	if !ok {
		return
	}

	go func() {
		defer func() {
			if rec := recover(); rec != nil && s.Log != nil {
				s.Log.Error("dispatch workspace notification panic", "wsId", wsID, "event", event, "panic", rec)
			}
		}()

		ctx, cancel := context.WithTimeout(context.Background(), notifChannelDispatchBudget)
		defer cancel()

		channels, err := ns.ListActiveNotificationChannelsForEvent(ctx, wsID, event)
		if err != nil {
			if s.Log != nil {
				s.Log.Warn("list notification channels failed", "wsId", wsID, "event", event, "err", err)
			}
			return
		}
		if len(channels) == 0 {
			return
		}

		var wg sync.WaitGroup
		for _, ch := range channels {
			ch := ch
			wg.Add(1)
			go func() {
				defer wg.Done()
				err := s.deliverNotificationChannel(ctx, ch, title, body, link)
				status := "ok"
				errMsg := ""
				if err != nil {
					status = "error"
					errMsg = err.Error()
				}
				if recErr := ns.RecordNotificationChannelDelivery(ctx, wsID, ch.ID, status, errMsg, s.now().UTC()); recErr != nil && s.Log != nil {
					s.Log.Warn("record notification channel delivery failed", "channelId", ch.ID, "err", recErr)
				}
			}()
		}
		wg.Wait()
	}()
}

// --- HTTP Handlers ---

func (s *Server) notifChannelError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, store.ErrUnauthenticated):
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
	case errors.Is(err, store.ErrForbidden):
		httpx.Error(w, http.StatusForbidden, "forbidden", "仅空间所有者或管理员可管理外部通知渠道")
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "通知渠道不存在")
	case errors.Is(err, store.ErrNotificationChannelLimitReached):
		httpx.Error(w, http.StatusConflict, "channel_limit_reached", fmt.Sprintf("当前空间最多可配置 %d 个外部通知渠道", store.MaxNotificationChannelsPerWorkspace))
	case errors.Is(err, store.ErrConflict):
		httpx.Error(w, http.StatusConflict, "channel_conflict", "通知渠道参数无效或发生冲突")
	default:
		s.fail(w, r, err)
	}
}

// listNotificationChannels handles GET /api/workspaces/{wsId}/notification-channels.
func (s *Server) listNotificationChannels(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	ns, ok := s.notificationChannelStore()
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "notification_channels_unavailable", "外部通知渠道服务未启用")
		return
	}
	channels, err := ns.ListNotificationChannels(r.Context(), guard, wsID)
	if err != nil {
		s.notifChannelError(w, r, err)
		return
	}
	if channels == nil {
		channels = []store.NotificationChannel{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"channels": channels})
}

type createNotificationChannelRequest struct {
	Name    string          `json:"name"`
	Kind    string          `json:"kind"`
	Config  json.RawMessage `json:"config"`
	Events  []string        `json:"events"`
	Enabled *bool           `json:"enabled"`
}

// createNotificationChannel handles POST /api/workspaces/{wsId}/notification-channels.
func (s *Server) createNotificationChannel(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	ns, ok := s.notificationChannelStore()
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "notification_channels_unavailable", "外部通知渠道服务未启用")
		return
	}
	var in createNotificationChannelRequest
	if !httpx.Decode(w, r, &in) {
		return
	}

	name := strings.TrimSpace(in.Name)
	if n := utf8.RuneCountInString(name); n < 1 || n > 100 {
		httpx.Error(w, http.StatusBadRequest, "invalid_name", "渠道名称需为 1-100 个字符")
		return
	}
	kind := strings.ToLower(strings.TrimSpace(in.Kind))
	if !store.IsValidNotificationChannelKind(kind) {
		httpx.Error(w, http.StatusBadRequest, "invalid_kind", "不支持的通知渠道类型")
		return
	}
	events, ok := store.NormalizeNotificationEvents(in.Events)
	if !ok {
		httpx.Error(w, http.StatusBadRequest, "invalid_events", "请至少选择一个有效的通知事件")
		return
	}
	configEnc, configHint, err := s.validateAndSealChannelConfig(wsID, kind, in.Config, nil, false)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_config", err.Error())
		return
	}
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}

	created, err := ns.CreateNotificationChannel(r.Context(), guard, wsID, store.NotificationChannelInput{
		Name:       name,
		Kind:       kind,
		ConfigEnc:  configEnc,
		ConfigHint: configHint,
		Events:     events,
		Enabled:    enabled,
	})
	if err != nil {
		s.notifChannelError(w, r, err)
		return
	}
	s.recordAudit(r, wsID, "notification_channel.create", "notification_channel", created.ID, created.Name, map[string]any{
		"kind":    created.Kind,
		"events":  created.Events,
		"enabled": created.Enabled,
	})
	httpx.JSON(w, http.StatusCreated, map[string]any{"channel": created})
}

type updateNotificationChannelRequest struct {
	Name    *string          `json:"name"`
	Kind    *string          `json:"kind"`
	Config  *json.RawMessage `json:"config"`
	Events  *[]string        `json:"events"`
	Enabled *bool            `json:"enabled"`
}

// updateNotificationChannel handles PATCH /api/workspaces/{wsId}/notification-channels/{cid}.
func (s *Server) updateNotificationChannel(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	cid, ok := s.parsePositivePathID(w, r, "cid")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	ns, ok := s.notificationChannelStore()
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "notification_channels_unavailable", "外部通知渠道服务未启用")
		return
	}
	var in updateNotificationChannelRequest
	if !httpx.Decode(w, r, &in) {
		return
	}

	existing, err := ns.GetNotificationChannel(r.Context(), guard, wsID, cid)
	if err != nil {
		s.notifChannelError(w, r, err)
		return
	}

	patch := store.NotificationChannelPatch{
		Enabled: in.Enabled,
	}
	if in.Name != nil {
		name := strings.TrimSpace(*in.Name)
		if n := utf8.RuneCountInString(name); n < 1 || n > 100 {
			httpx.Error(w, http.StatusBadRequest, "invalid_name", "渠道名称需为 1-100 个字符")
			return
		}
		patch.Name = &name
	}
	targetKind := existing.Kind
	if in.Kind != nil {
		k := strings.ToLower(strings.TrimSpace(*in.Kind))
		if !store.IsValidNotificationChannelKind(k) {
			httpx.Error(w, http.StatusBadRequest, "invalid_kind", "不支持的通知渠道类型")
			return
		}
		targetKind = k
		patch.Kind = &k
	}
	if in.Events != nil {
		events, ok := store.NormalizeNotificationEvents(*in.Events)
		if !ok {
			httpx.Error(w, http.StatusBadRequest, "invalid_events", "请至少选择一个有效的通知事件")
			return
		}
		patch.Events = &events
	}
	hasConfigUpdate := in.Config != nil && len(bytes.TrimSpace(*in.Config)) > 0 && string(bytes.TrimSpace(*in.Config)) != "null"
	if targetKind != existing.Kind && !hasConfigUpdate {
		httpx.Error(w, http.StatusBadRequest, "invalid_config", "更改渠道类型时必须提供新的渠道配置")
		return
	}
	if hasConfigUpdate {
		var existingPlain []byte
		if targetKind == existing.Kind && len(existing.ConfigEnc) > 0 {
			existingPlain, _ = openNotifChannelConfig(s.notifChannelSecretKey(), wsID, existing.ConfigEnc)
		}
		configEnc, configHint, err := s.validateAndSealChannelConfig(wsID, targetKind, *in.Config, existingPlain, targetKind == existing.Kind)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid_config", err.Error())
			return
		}
		patch.UpdateConfig = true
		patch.ConfigEnc = configEnc
		patch.ConfigHint = configHint
	}

	updated, err := ns.UpdateNotificationChannel(r.Context(), guard, wsID, cid, patch)
	if err != nil {
		s.notifChannelError(w, r, err)
		return
	}
	s.recordAudit(r, wsID, "notification_channel.update", "notification_channel", updated.ID, updated.Name, map[string]any{
		"kind":    updated.Kind,
		"events":  updated.Events,
		"enabled": updated.Enabled,
	})
	httpx.JSON(w, http.StatusOK, map[string]any{"channel": updated})
}

// deleteNotificationChannel handles DELETE /api/workspaces/{wsId}/notification-channels/{cid}.
func (s *Server) deleteNotificationChannel(w http.ResponseWriter, r *http.Request) {
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	cid, ok := s.parsePositivePathID(w, r, "cid")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	ns, ok := s.notificationChannelStore()
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "notification_channels_unavailable", "外部通知渠道服务未启用")
		return
	}
	if err := ns.DeleteNotificationChannel(r.Context(), guard, wsID, cid); err != nil {
		s.notifChannelError(w, r, err)
		return
	}
	s.recordAudit(r, wsID, "notification_channel.delete", "notification_channel", cid, "", nil)
	w.WriteHeader(http.StatusNoContent)
}

// testNotificationChannel handles POST /api/workspaces/{wsId}/notification-channels/{cid}/test.
func (s *Server) testNotificationChannel(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	cid, ok := s.parsePositivePathID(w, r, "cid")
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	ns, ok := s.notificationChannelStore()
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "notification_channels_unavailable", "外部通知渠道服务未启用")
		return
	}
	ch, err := ns.GetNotificationChannel(r.Context(), guard, wsID, cid)
	if err != nil {
		s.notifChannelError(w, r, err)
		return
	}

	start := time.Now()
	testCtx, cancel := context.WithTimeout(r.Context(), notifChannelDispatchBudget)
	defer cancel()

	sendErr := s.deliverNotificationChannel(testCtx, ch, notifChannelTestTitle, notifChannelTestBody, "")
	latencyMs := time.Since(start).Milliseconds()
	sentAt := s.now().UTC()

	status := "ok"
	errMsg := ""
	if sendErr != nil {
		status = "error"
		errMsg = sendErr.Error()
	}
	if recErr := ns.RecordNotificationChannelDelivery(r.Context(), wsID, ch.ID, status, errMsg, sentAt); recErr != nil && s.Log != nil {
		s.Log.Warn("record test notification delivery failed", "channelId", ch.ID, "err", recErr)
	}

	ch.ConfigEnc = nil
	ch.LastStatus = status
	ch.LastError = errMsg
	ch.LastSentAt = &sentAt

	httpx.JSON(w, http.StatusOK, map[string]any{
		"ok":        sendErr == nil,
		"status":    status,
		"error":     errMsg,
		"latencyMs": latencyMs,
		"sentAt":    sentAt,
		"channel":   ch,
	})
}

func docNotificationLink(kind string, id int64) string {
	switch kind {
	case "base":
		return fmt.Sprintf("/bases/%d", id)
	case "sheet":
		return fmt.Sprintf("/sheets/%d", id)
	case "slides":
		return fmt.Sprintf("/slides/%d", id)
	case "survey":
		return fmt.Sprintf("/surveys/%d", id)
	default:
		return fmt.Sprintf("/docs/%d", id)
	}
}

func (s *Server) notifyCommentExternalChannels(d store.DocMeta, actor store.User, c store.Comment) {
	if d.WorkspaceID <= 0 {
		return
	}
	actorName := strings.TrimSpace(actor.Name)
	if actorName == "" {
		actorName = strings.TrimSpace(actor.Email)
	}
	if actorName == "" {
		actorName = "成员"
	}
	docTitle := strings.TrimSpace(d.Title)
	if docTitle == "" {
		docTitle = "未命名文档"
	}
	preview := snippet(c.Body)
	link := docNotificationLink(d.Kind, d.ID)

	hasExternalMention := false
	for _, uid := range c.Mentions {
		if uid > 0 && uid != actor.ID {
			hasExternalMention = true
			break
		}
	}
	if hasExternalMention {
		title := fmt.Sprintf("【@提及】%s 在「%s」中提到了成员", actorName, docTitle)
		s.dispatchWorkspaceNotification(d.WorkspaceID, store.NotificationEventMention, title, preview, link)
	}
	if c.ParentID != nil {
		title := fmt.Sprintf("【评论回复】%s 回复了「%s」中的评论", actorName, docTitle)
		s.dispatchWorkspaceNotification(d.WorkspaceID, store.NotificationEventCommentReply, title, preview, link)
	}
}
