package api

import (
	"bufio"
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

const (
	orgConnectorDevSecretSeed  = "jiange-dev-org-connector-secret"
	orgConnectorHTTPTimeout    = 20 * time.Second
	orgConnectorLDAPTimeout    = 25 * time.Second
	orgConnectorMaxHTTPBody    = 16 << 20 // 16 MiB
	orgConnectorMaxLDAPMsg     = 16 << 20
	orgConnectorMaxLDAPEntries = 10000
	orgConnectorMaxDepts       = 500
	orgConnectorMaxDeptDepth   = 32
	orgConnectorMaxDingPages   = 100

	defaultWeComEndpoint    = "https://qyapi.weixin.qq.com"
	defaultDingTalkEndpoint = "https://oapi.dingtalk.com"
	defaultLDAPUserFilter   = "(objectClass=inetOrgPerson)"
	defaultLDAPDeptFilter   = "(objectClass=organizationalUnit)"
	defaultLDAPEmailAttr    = "mail"
	defaultLDAPNameAttr     = "cn"
	defaultLDAPDeptAttr     = "ou"
)

// Test-only hooks allowing SweepScheduledOrgSyncs tests to reach local mock servers.
var (
	orgConnectorTestAllowAddr func(netip.Addr) bool
	orgConnectorTestAllowHTTP bool
	orgSyncSweeperNow         func() time.Time
)

// OrgConnectorConfig stores active directory pull credentials and query settings.
// Sensitive fields (BindPassword, CorpSecret, AppSecret) are sealed with AES-256-GCM
// before persistence and never returned to API clients.
type OrgConnectorConfig struct {
	EndpointURL string `json:"endpointUrl,omitempty"`

	// LDAP v3
	BindDN             string `json:"bindDn,omitempty"`
	BindPassword       string `json:"bindPassword,omitempty"`
	BaseDN             string `json:"baseDn,omitempty"`
	UserFilter         string `json:"userFilter,omitempty"`
	DeptFilter         string `json:"deptFilter,omitempty"`
	EmailAttr          string `json:"emailAttr,omitempty"`
	NameAttr           string `json:"nameAttr,omitempty"`
	DeptAttr           string `json:"deptAttr,omitempty"`
	InsecureSkipVerify bool   `json:"insecureSkipVerify,omitempty"`

	// WeCom (企业微信)
	CorpID     string `json:"corpId,omitempty"`
	CorpSecret string `json:"corpSecret,omitempty"`

	// DingTalk (钉钉)
	AppKey    string `json:"appKey,omitempty"`
	AppSecret string `json:"appSecret,omitempty"`

	// Shared root department ID for WeCom & DingTalk (defaults to 1).
	RootDeptID int64 `json:"rootDeptId,omitempty"`
}

type orgConnectorNetOpts struct {
	allowAddr  func(netip.Addr) bool
	allowHTTP  bool
	httpClient *http.Client
}

func orgConnectorSecretKey(aiSecret []byte) []byte {
	if len(aiSecret) > 0 {
		h := sha256.New()
		h.Write([]byte("jiange-org-connector-secret-key:"))
		h.Write(aiSecret)
		return h.Sum(nil)
	}
	sum := sha256.Sum256([]byte(orgConnectorDevSecretSeed))
	return sum[:]
}

func (s *Server) orgConnectorSecretKey() []byte {
	return orgConnectorSecretKey(s.AISecret)
}

func orgConnectorAAD(workspaceID, sourceID int64) []byte {
	return []byte("jiange-org-connector:" + strconv.FormatInt(workspaceID, 10) + ":" + strconv.FormatInt(sourceID, 10))
}

func sealOrgConnectorConfig(key []byte, workspaceID, sourceID int64, cfg OrgConnectorConfig) ([]byte, error) {
	plain, err := json.Marshal(cfg)
	if err != nil {
		return nil, err
	}
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
	return gcm.Seal(nonce, nonce, plain, orgConnectorAAD(workspaceID, sourceID)), nil
}

func openOrgConnectorConfig(key []byte, workspaceID, sourceID int64, sealed []byte) (OrgConnectorConfig, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return OrgConnectorConfig{}, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return OrgConnectorConfig{}, err
	}
	if len(sealed) < gcm.NonceSize() {
		return OrgConnectorConfig{}, errors.New("short ciphertext")
	}
	plain, err := gcm.Open(nil, sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():], orgConnectorAAD(workspaceID, sourceID))
	if err != nil {
		return OrgConnectorConfig{}, err
	}
	var cfg OrgConnectorConfig
	if err := json.Unmarshal(plain, &cfg); err != nil {
		return OrgConnectorConfig{}, err
	}
	return cfg, nil
}

func maskConnectorSecretTail(secret string) string {
	s := strings.TrimSpace(secret)
	if s == "" {
		return ""
	}
	if len(s) >= 4 {
		return "****" + s[len(s)-4:]
	}
	return "****"
}

func truncateHint(s string, maxRunes int) string {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) <= maxRunes {
		return s
	}
	r := []rune(s)
	return string(r[:maxRunes-1]) + "…"
}

func orgConnectorConfigHint(provider string, cfg OrgConnectorConfig) string {
	switch provider {
	case store.OrgSyncProviderLDAP:
		parts := []string{}
		if cfg.BaseDN != "" {
			parts = append(parts, "base="+cfg.BaseDN)
		}
		if cfg.BindDN != "" {
			parts = append(parts, "bind="+cfg.BindDN)
		}
		if cfg.BindPassword != "" {
			parts = append(parts, "pwd="+maskConnectorSecretTail(cfg.BindPassword))
		}
		return truncateHint(strings.Join(parts, " · "), 200)
	case store.OrgSyncProviderWeCom:
		return truncateHint(fmt.Sprintf("corpId=%s · secret=%s", cfg.CorpID, maskConnectorSecretTail(cfg.CorpSecret)), 200)
	case store.OrgSyncProviderDingTalk:
		return truncateHint(fmt.Sprintf("appKey=%s · secret=%s", cfg.AppKey, maskConnectorSecretTail(cfg.AppSecret)), 200)
	default:
		return ""
	}
}

func (s *Server) orgConnectorNetOpts() orgConnectorNetOpts {
	allowAddr := s.PreviewAllow
	if allowAddr == nil {
		allowAddr = orgConnectorTestAllowAddr
	}
	allowHTTP := s.SSOAllowHTTP || s.PreviewAllow != nil || orgConnectorTestAllowHTTP
	var client *http.Client
	if s.SSOTransport != nil {
		client = &http.Client{
			Timeout:   orgConnectorHTTPTimeout,
			Transport: s.SSOTransport,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	return orgConnectorNetOpts{
		allowAddr:  allowAddr,
		allowHTTP:  allowHTTP,
		httpClient: client,
	}
}

func defaultOrgConnectorNetOpts() orgConnectorNetOpts {
	return orgConnectorNetOpts{
		allowAddr: orgConnectorTestAllowAddr,
		allowHTTP: orgConnectorTestAllowHTTP,
	}
}

func validateConnectorHTTPURL(raw string, opts orgConnectorNetOpts) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || len(trimmed) > 1024 {
		return "", errors.New("连接器地址无效")
	}
	u, err := url.Parse(trimmed)
	if err != nil || u.Host == "" || u.User != nil || u.Fragment != "" {
		return "", errors.New("连接器地址格式无效")
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "https" && !(opts.allowHTTP && scheme == "http") {
		return "", errors.New("连接器地址仅支持 https 协议")
	}
	if opts.httpClient == nil {
		allow := publicAddr
		if opts.allowAddr != nil {
			allow = opts.allowAddr
		}
		if ip, err := netip.ParseAddr(u.Hostname()); err == nil && !allow(ip) {
			return "", errBlockedAddress
		}
	}
	u.Path = strings.TrimRight(u.Path, "/")
	return u.String(), nil
}

func ldapDefaultAddrAllowed(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsValid() || ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsLoopback() {
		return false
	}
	return true
}

func validateConnectorLDAPURL(raw string, opts orgConnectorNetOpts) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || len(trimmed) > 1024 {
		return "", errors.New("LDAP 地址不能为空（如 ldaps://ad.example.com:636）")
	}
	u, err := url.Parse(trimmed)
	if err != nil || u.Host == "" || u.User != nil || u.Fragment != "" {
		return "", errors.New("LDAP 地址格式无效")
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "ldap" && scheme != "ldaps" {
		return "", errors.New("LDAP 地址仅支持 ldap:// 或 ldaps://")
	}
	allow := ldapDefaultAddrAllowed
	if opts.allowAddr != nil {
		allow = opts.allowAddr
	}
	if ip, err := netip.ParseAddr(u.Hostname()); err == nil && !allow(ip) {
		return "", errBlockedAddress
	}
	return u.String(), nil
}

func validateOrgConnectorEndpoint(provider, raw string, opts orgConnectorNetOpts) (string, error) {
	raw = strings.TrimSpace(raw)
	switch provider {
	case store.OrgSyncProviderLDAP:
		if raw == "" {
			return "", errors.New("LDAP 服务地址不能为空")
		}
		return validateConnectorLDAPURL(raw, opts)
	case store.OrgSyncProviderWeCom:
		if raw == "" {
			raw = defaultWeComEndpoint
		}
		return validateConnectorHTTPURL(raw, opts)
	case store.OrgSyncProviderDingTalk:
		if raw == "" {
			raw = defaultDingTalkEndpoint
		}
		return validateConnectorHTTPURL(raw, opts)
	default:
		if raw == "" {
			return "", nil
		}
		return validateConnectorHTTPURL(raw, opts)
	}
}

// mergeAndValidateConnectorConfig normalizes incoming connector configuration,
// preserving existing secrets if the caller left secret fields empty during an update.
func mergeAndValidateConnectorConfig(provider, topEndpoint string, in OrgConnectorConfig, existing *OrgConnectorConfig, opts orgConnectorNetOpts) (OrgConnectorConfig, string, error) {
	cfg := OrgConnectorConfig{
		EndpointURL:        strings.TrimSpace(in.EndpointURL),
		BindDN:             strings.TrimSpace(in.BindDN),
		BindPassword:       in.BindPassword,
		BaseDN:             strings.TrimSpace(in.BaseDN),
		UserFilter:         strings.TrimSpace(in.UserFilter),
		DeptFilter:         strings.TrimSpace(in.DeptFilter),
		EmailAttr:          strings.TrimSpace(in.EmailAttr),
		NameAttr:           strings.TrimSpace(in.NameAttr),
		DeptAttr:           strings.TrimSpace(in.DeptAttr),
		InsecureSkipVerify: in.InsecureSkipVerify,
		CorpID:             strings.TrimSpace(in.CorpID),
		CorpSecret:         strings.TrimSpace(in.CorpSecret),
		AppKey:             strings.TrimSpace(in.AppKey),
		AppSecret:          strings.TrimSpace(in.AppSecret),
		RootDeptID:         in.RootDeptID,
	}
	if cfg.EndpointURL == "" {
		cfg.EndpointURL = strings.TrimSpace(topEndpoint)
	}
	if existing != nil {
		if cfg.EndpointURL == "" {
			cfg.EndpointURL = existing.EndpointURL
		}
		if cfg.BindPassword == "" {
			cfg.BindPassword = existing.BindPassword
		}
		if cfg.CorpSecret == "" {
			cfg.CorpSecret = existing.CorpSecret
		}
		if cfg.AppSecret == "" {
			cfg.AppSecret = existing.AppSecret
		}
	}

	switch provider {
	case store.OrgSyncProviderLDAP:
		ep, err := validateConnectorLDAPURL(cfg.EndpointURL, opts)
		if err != nil {
			return OrgConnectorConfig{}, "", err
		}
		cfg.EndpointURL = ep
		if cfg.BaseDN == "" {
			return OrgConnectorConfig{}, "", errors.New("LDAP Base DN 不能为空")
		}
		if cfg.UserFilter == "" {
			cfg.UserFilter = defaultLDAPUserFilter
		}
		if cfg.DeptFilter == "" {
			cfg.DeptFilter = defaultLDAPDeptFilter
		}
		if cfg.EmailAttr == "" {
			cfg.EmailAttr = defaultLDAPEmailAttr
		}
		if cfg.NameAttr == "" {
			cfg.NameAttr = defaultLDAPNameAttr
		}
		if cfg.DeptAttr == "" {
			cfg.DeptAttr = defaultLDAPDeptAttr
		}
		if _, err := ldapParseFilter(cfg.UserFilter); err != nil {
			return OrgConnectorConfig{}, "", fmt.Errorf("LDAP 用户过滤条件无效：%w", err)
		}
		if _, err := ldapParseFilter(cfg.DeptFilter); err != nil {
			return OrgConnectorConfig{}, "", fmt.Errorf("LDAP 部门过滤条件无效：%w", err)
		}
		return cfg, cfg.EndpointURL, nil

	case store.OrgSyncProviderWeCom:
		if cfg.EndpointURL == "" {
			cfg.EndpointURL = defaultWeComEndpoint
		}
		ep, err := validateConnectorHTTPURL(cfg.EndpointURL, opts)
		if err != nil {
			return OrgConnectorConfig{}, "", err
		}
		cfg.EndpointURL = ep
		if cfg.CorpID == "" {
			return OrgConnectorConfig{}, "", errors.New("企业微信 CorpID 不能为空")
		}
		if cfg.CorpSecret == "" {
			return OrgConnectorConfig{}, "", errors.New("企业微信 CorpSecret 不能为空")
		}
		if cfg.RootDeptID <= 0 {
			cfg.RootDeptID = 1
		}
		return cfg, cfg.EndpointURL, nil

	case store.OrgSyncProviderDingTalk:
		if cfg.EndpointURL == "" {
			cfg.EndpointURL = defaultDingTalkEndpoint
		}
		ep, err := validateConnectorHTTPURL(cfg.EndpointURL, opts)
		if err != nil {
			return OrgConnectorConfig{}, "", err
		}
		cfg.EndpointURL = ep
		if cfg.AppKey == "" {
			return OrgConnectorConfig{}, "", errors.New("钉钉 AppKey 不能为空")
		}
		if cfg.AppSecret == "" {
			return OrgConnectorConfig{}, "", errors.New("钉钉 AppSecret 不能为空")
		}
		if cfg.RootDeptID <= 0 {
			cfg.RootDeptID = 1
		}
		return cfg, cfg.EndpointURL, nil

	default:
		return OrgConnectorConfig{}, "", errors.New("仅 LDAP、企业微信和钉钉同步源支持主动拉取连接器配置")
	}
}

func orgConnectorHTTPClient(opts orgConnectorNetOpts) *http.Client {
	if opts.httpClient != nil {
		return opts.httpClient
	}
	allow := publicAddr
	if opts.allowAddr != nil {
		allow = opts.allowAddr
	}
	dialer := &net.Dialer{
		Timeout: 10 * time.Second,
		Control: func(_, address string, _ syscall.RawConn) error {
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
	return &http.Client{
		Timeout: orgConnectorHTTPTimeout,
		Transport: &http.Transport{
			Proxy:                  nil,
			DialContext:            dialer.DialContext,
			TLSHandshakeTimeout:    10 * time.Second,
			ResponseHeaderTimeout:  orgConnectorHTTPTimeout,
			MaxResponseHeaderBytes: 64 << 10,
			DisableKeepAlives:      true,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func pullOrgDirectory(ctx context.Context, provider string, cfg OrgConnectorConfig, opts orgConnectorNetOpts) (store.OrgDirectorySyncPayload, error) {
	switch provider {
	case store.OrgSyncProviderLDAP:
		return pullLDAPDirectory(ctx, cfg, opts)
	case store.OrgSyncProviderWeCom:
		return pullWeComDirectory(ctx, cfg, opts)
	case store.OrgSyncProviderDingTalk:
		return pullDingTalkDirectory(ctx, cfg, opts)
	default:
		return store.OrgDirectorySyncPayload{}, fmt.Errorf("unsupported pull provider: %s", provider)
	}
}

// ============================================================================
// Pure-Go RFC 4511 LDAP v3 ASN.1 BER Client & RFC 4515 Filter Compiler
// ============================================================================

const (
	berTagBoolean     byte = 0x01
	berTagInteger     byte = 0x02
	berTagOctetString byte = 0x04
	berTagNull        byte = 0x05
	berTagEnumerated  byte = 0x0A
	berTagSequence    byte = 0x30
	berTagSet         byte = 0x31

	ldapAppBindRequest    byte = 0x60 // [APPLICATION 0] CONSTRUCTED
	ldapAppBindResponse   byte = 0x61 // [APPLICATION 1] CONSTRUCTED
	ldapAppUnbindRequest  byte = 0x42 // [APPLICATION 2] PRIMITIVE NULL
	ldapAppSearchRequest  byte = 0x63 // [APPLICATION 3] CONSTRUCTED
	ldapAppSearchResEntry byte = 0x64 // [APPLICATION 4] CONSTRUCTED
	ldapAppSearchResDone  byte = 0x65 // [APPLICATION 5] CONSTRUCTED
	ldapAppSearchResRef   byte = 0x73 // [APPLICATION 19] CONSTRUCTED
)

func berEncodeLength(n int) []byte {
	if n < 0x80 {
		return []byte{byte(n)}
	}
	var tmp [4]byte
	i := len(tmp)
	v := n
	for v > 0 {
		i--
		tmp[i] = byte(v & 0xFF)
		v >>= 8
	}
	count := len(tmp) - i
	out := make([]byte, 1+count)
	out[0] = byte(0x80 | count)
	copy(out[1:], tmp[i:])
	return out
}

func berTLV(tag byte, value []byte) []byte {
	lenBytes := berEncodeLength(len(value))
	out := make([]byte, 1+len(lenBytes)+len(value))
	out[0] = tag
	copy(out[1:], lenBytes)
	copy(out[1+len(lenBytes):], value)
	return out
}

func berEncodeIntBytes(v int) []byte {
	if v == 0 {
		return []byte{0}
	}
	var buf [8]byte
	n := 0
	x := v
	for {
		buf[len(buf)-1-n] = byte(x & 0xFF)
		n++
		if v > 0 {
			x >>= 8
			if x == 0 {
				if buf[len(buf)-n]&0x80 != 0 {
					buf[len(buf)-1-n] = 0
					n++
				}
				break
			}
		} else {
			x >>= 8
			if x == -1 && buf[len(buf)-n]&0x80 != 0 {
				break
			}
			if n == len(buf) {
				break
			}
		}
	}
	out := make([]byte, n)
	copy(out, buf[len(buf)-n:])
	return out
}

func berInt(v int) []byte {
	return berTLV(berTagInteger, berEncodeIntBytes(v))
}

func berEnum(v int) []byte {
	return berTLV(berTagEnumerated, berEncodeIntBytes(v))
}

func berBool(v bool) []byte {
	if v {
		return berTLV(berTagBoolean, []byte{0xFF})
	}
	return berTLV(berTagBoolean, []byte{0x00})
}

func berOctetString(s string) []byte {
	return berTLV(berTagOctetString, []byte(s))
}

func berConcat(parts ...[]byte) []byte {
	total := 0
	for _, p := range parts {
		total += len(p)
	}
	out := make([]byte, 0, total)
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

func berSequence(parts ...[]byte) []byte {
	return berTLV(berTagSequence, berConcat(parts...))
}

func berDecodeInt(val []byte) (int, error) {
	if len(val) == 0 || len(val) > 8 {
		return 0, errors.New("invalid BER integer length")
	}
	var res int64
	if val[0]&0x80 != 0 {
		res = -1
	}
	for _, b := range val {
		res = (res << 8) | int64(b)
	}
	return int(res), nil
}

func berParseElement(buf []byte) (byte, []byte, []byte, error) {
	if len(buf) < 2 {
		return 0, nil, nil, errors.New("truncated BER element")
	}
	tag := buf[0]
	pos := 1
	if (tag & 0x1F) == 0x1F {
		for {
			if pos >= len(buf) {
				return 0, nil, nil, errors.New("truncated BER high tag")
			}
			b := buf[pos]
			pos++
			if b&0x80 == 0 {
				break
			}
		}
	}
	if pos >= len(buf) {
		return 0, nil, nil, errors.New("truncated BER length")
	}
	lb := buf[pos]
	pos++
	var length int
	if lb < 0x80 {
		length = int(lb)
	} else {
		nBytes := int(lb & 0x7F)
		if nBytes == 0 || nBytes > 4 || pos+nBytes > len(buf) {
			return 0, nil, nil, errors.New("invalid BER length")
		}
		for i := 0; i < nBytes; i++ {
			length = (length << 8) | int(buf[pos+i])
		}
		pos += nBytes
	}
	if length < 0 || pos+length > len(buf) {
		return 0, nil, nil, errors.New("BER element exceeds buffer")
	}
	return tag, buf[pos : pos+length], buf[pos+length:], nil
}

func berReadTLV(r *bufio.Reader, maxLen int) (byte, []byte, error) {
	tag, err := r.ReadByte()
	if err != nil {
		return 0, nil, err
	}
	if (tag & 0x1F) == 0x1F {
		for {
			b, err := r.ReadByte()
			if err != nil {
				return 0, nil, err
			}
			if b&0x80 == 0 {
				break
			}
		}
	}
	lb, err := r.ReadByte()
	if err != nil {
		return 0, nil, err
	}
	var length int
	if lb < 0x80 {
		length = int(lb)
	} else {
		nBytes := int(lb & 0x7F)
		if nBytes == 0 || nBytes > 4 {
			return 0, nil, errors.New("unsupported BER length encoding")
		}
		for i := 0; i < nBytes; i++ {
			b, err := r.ReadByte()
			if err != nil {
				return 0, nil, err
			}
			length = (length << 8) | int(b)
		}
	}
	if length < 0 || length > maxLen {
		return 0, nil, fmt.Errorf("BER payload size %d exceeds limit", length)
	}
	val := make([]byte, length)
	if _, err := io.ReadFull(r, val); err != nil {
		return 0, nil, err
	}
	return tag, val, nil
}

// ldapParseFilter compiles an RFC 4515 LDAP search filter string into ASN.1 BER.
func ldapParseFilter(raw string) ([]byte, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return nil, errors.New("empty filter")
	}
	if !strings.HasPrefix(s, "(") {
		s = "(" + s + ")"
	}
	encoded, pos, err := parseLDAPFilterExpr(s, 0, 0)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(s[pos:]) != "" {
		return nil, errors.New("unexpected trailing characters in LDAP filter")
	}
	return encoded, nil
}

func parseLDAPFilterExpr(s string, pos int, depth int) ([]byte, int, error) {
	if depth > 32 {
		return nil, pos, errors.New("LDAP filter nesting too deep")
	}
	if pos >= len(s) || s[pos] != '(' {
		return nil, pos, errors.New("expected '(' in LDAP filter")
	}
	pos++
	if pos >= len(s) {
		return nil, pos, errors.New("unterminated LDAP filter")
	}
	switch s[pos] {
	case '&', '|':
		op := s[pos]
		pos++
		var children [][]byte
		for pos < len(s) && s[pos] != ')' {
			child, nextPos, err := parseLDAPFilterExpr(s, pos, depth+1)
			if err != nil {
				return nil, nextPos, err
			}
			children = append(children, child)
			pos = nextPos
		}
		if pos >= len(s) || s[pos] != ')' || len(children) == 0 {
			return nil, pos, errors.New("malformed compound LDAP filter")
		}
		tag := byte(0xA0) // AND [0]
		if op == '|' {
			tag = 0xA1 // OR [1]
		}
		return berTLV(tag, berConcat(children...)), pos + 1, nil

	case '!':
		pos++
		child, nextPos, err := parseLDAPFilterExpr(s, pos, depth+1)
		if err != nil {
			return nil, nextPos, err
		}
		if nextPos >= len(s) || s[nextPos] != ')' {
			return nil, nextPos, errors.New("malformed NOT LDAP filter")
		}
		return berTLV(0xA2, child), nextPos + 1, nil
	}

	// Simple filter item until matching ')'
	end := strings.IndexByte(s[pos:], ')')
	if end < 0 {
		return nil, pos, errors.New("missing ')' in LDAP filter")
	}
	item := s[pos : pos+end]
	nextPos := pos + end + 1

	var attr, val string
	var opTag byte
	switch {
	case strings.Contains(item, ">="):
		idx := strings.Index(item, ">=")
		attr, val, opTag = item[:idx], item[idx+2:], 0xA5
	case strings.Contains(item, "<="):
		idx := strings.Index(item, "<=")
		attr, val, opTag = item[:idx], item[idx+2:], 0xA6
	case strings.Contains(item, "~="):
		idx := strings.Index(item, "~=")
		attr, val, opTag = item[:idx], item[idx+2:], 0xA8
	case strings.Contains(item, "="):
		idx := strings.IndexByte(item, '=')
		attr, val, opTag = item[:idx], item[idx+1:], 0xA3
	default:
		return nil, pos, fmt.Errorf("invalid LDAP filter item %q", item)
	}
	attr = strings.TrimSpace(attr)
	if attr == "" {
		return nil, pos, errors.New("empty attribute name in LDAP filter")
	}
	if opTag == 0xA3 && val == "*" {
		// Present filter: [7] AttributeDescription (primitive)
		return berTLV(0x87, []byte(attr)), nextPos, nil
	}
	if opTag == 0xA3 && strings.Contains(val, "*") {
		// Substring filter: [4] SEQUENCE { type OCTET STRING, substrings SEQUENCE OF CHOICE }
		parts := strings.Split(val, "*")
		var subs [][]byte
		for i, part := range parts {
			if part == "" {
				continue
			}
			unesc, err := ldapUnescapeFilterValue(part)
			if err != nil {
				return nil, pos, err
			}
			var subTag byte = 0x81 // any [1]
			if i == 0 {
				subTag = 0x80 // initial [0]
			} else if i == len(parts)-1 {
				subTag = 0x82 // final [2]
			}
			subs = append(subs, berTLV(subTag, unesc))
		}
		body := berConcat(berOctetString(attr), berSequence(subs...))
		return berTLV(0xA4, body), nextPos, nil
	}
	unesc, err := ldapUnescapeFilterValue(val)
	if err != nil {
		return nil, pos, err
	}
	body := berConcat(berOctetString(attr), berTLV(berTagOctetString, unesc))
	return berTLV(opTag, body), nextPos, nil
}

func ldapUnescapeFilterValue(s string) ([]byte, error) {
	var out bytes.Buffer
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' {
			if i+2 >= len(s) {
				return nil, errors.New("incomplete escape in LDAP filter")
			}
			v, err := strconv.ParseUint(s[i+1:i+3], 16, 8)
			if err != nil {
				return nil, errors.New("invalid hex escape in LDAP filter")
			}
			out.WriteByte(byte(v))
			i += 2
		} else {
			out.WriteByte(s[i])
		}
	}
	return out.Bytes(), nil
}

type ldapEntry struct {
	DN    string
	Attrs map[string][]string
}

func (e ldapEntry) first(keys ...string) string {
	for _, k := range keys {
		vals := e.Attrs[strings.ToLower(strings.TrimSpace(k))]
		for _, v := range vals {
			if t := strings.TrimSpace(v); t != "" {
				return t
			}
		}
	}
	return ""
}

func (e ldapEntry) all(key string) []string {
	return e.Attrs[strings.ToLower(strings.TrimSpace(key))]
}

type ldapConn struct {
	conn  net.Conn
	r     *bufio.Reader
	msgID int
}

func dialLDAP(ctx context.Context, endpoint string, insecureSkipVerify bool, opts orgConnectorNetOpts) (*ldapConn, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return nil, err
	}
	scheme := strings.ToLower(u.Scheme)
	host := u.Hostname()
	port := u.Port()
	if port == "" {
		if scheme == "ldaps" {
			port = "636"
		} else {
			port = "389"
		}
	}
	allow := ldapDefaultAddrAllowed
	if opts.allowAddr != nil {
		allow = opts.allowAddr
	}
	dialer := &net.Dialer{
		Timeout: 10 * time.Second,
		Control: func(_, address string, _ syscall.RawConn) error {
			h, _, err := net.SplitHostPort(address)
			if err != nil {
				return errBlockedAddress
			}
			ip, err := netip.ParseAddr(h)
			if err != nil || !allow(ip) {
				return errBlockedAddress
			}
			return nil
		},
	}
	addr := net.JoinHostPort(host, port)
	var rawConn net.Conn
	if scheme == "ldaps" {
		tlsDialer := &tls.Dialer{
			NetDialer: dialer,
			Config: &tls.Config{
				ServerName:         host,
				MinVersion:         tls.VersionTLS12,
				InsecureSkipVerify: insecureSkipVerify, //nolint:gosec // explicit admin option for internal self-signed AD/LDAPS
			},
		}
		rawConn, err = tlsDialer.DialContext(ctx, "tcp", addr)
	} else {
		rawConn, err = dialer.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(orgConnectorLDAPTimeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = rawConn.SetDeadline(deadline)
	return &ldapConn{conn: rawConn, r: bufio.NewReaderSize(rawConn, 16*1024)}, nil
}

func (c *ldapConn) nextID() int {
	c.msgID++
	return c.msgID
}

func (c *ldapConn) writeMessage(msgID int, op []byte) error {
	pkt := berSequence(berInt(msgID), op)
	_, err := c.conn.Write(pkt)
	return err
}

func (c *ldapConn) readMessage() (msgID int, opTag byte, opVal []byte, err error) {
	tag, body, err := berReadTLV(c.r, orgConnectorMaxLDAPMsg)
	if err != nil {
		return 0, 0, nil, err
	}
	if tag != berTagSequence {
		return 0, 0, nil, fmt.Errorf("expected LDAPMessage SEQUENCE, got 0x%02x", tag)
	}
	idTag, idVal, rest, err := berParseElement(body)
	if err != nil || idTag != berTagInteger {
		return 0, 0, nil, errors.New("invalid LDAPMessage messageID")
	}
	msgID, err = berDecodeInt(idVal)
	if err != nil {
		return 0, 0, nil, err
	}
	opTag, opVal, _, err = berParseElement(rest)
	if err != nil {
		return 0, 0, nil, err
	}
	return msgID, opTag, opVal, nil
}

func parseLDAPResult(val []byte) (resultCode int, diagMsg string, err error) {
	codeTag, codeVal, rest, err := berParseElement(val)
	if err != nil || codeTag != berTagEnumerated {
		return 0, "", errors.New("invalid LDAPResult resultCode")
	}
	resultCode, err = berDecodeInt(codeVal)
	if err != nil {
		return 0, "", err
	}
	// matchedDN
	_, _, rest, err = berParseElement(rest)
	if err != nil {
		return resultCode, "", nil
	}
	// diagnosticMessage
	if len(rest) > 0 {
		_, msgVal, _, merr := berParseElement(rest)
		if merr == nil {
			diagMsg = string(msgVal)
		}
	}
	return resultCode, diagMsg, nil
}

func (c *ldapConn) Bind(bindDN, password string) error {
	id := c.nextID()
	bindReq := berTLV(ldapAppBindRequest, berConcat(
		berInt(3),                      // LDAP v3
		berOctetString(bindDN),         // name
		berTLV(0x80, []byte(password)), // simple auth [0] OCTET STRING
	))
	if err := c.writeMessage(id, bindReq); err != nil {
		return fmt.Errorf("LDAP Bind 发送失败: %w", err)
	}
	gotID, opTag, opVal, err := c.readMessage()
	if err != nil {
		return fmt.Errorf("LDAP Bind 响应读取失败: %w", err)
	}
	if gotID != id || opTag != ldapAppBindResponse {
		return fmt.Errorf("LDAP Bind 响应异常 (msgId=%d tag=0x%02x)", gotID, opTag)
	}
	code, diag, err := parseLDAPResult(opVal)
	if err != nil {
		return err
	}
	if code != 0 {
		if diag != "" {
			return fmt.Errorf("LDAP 认证失败 (code=%d): %s", code, diag)
		}
		return fmt.Errorf("LDAP 认证失败 (code=%d)", code)
	}
	return nil
}

func (c *ldapConn) Search(baseDN, filter string, attrs []string) ([]ldapEntry, error) {
	filterBER, err := ldapParseFilter(filter)
	if err != nil {
		return nil, err
	}
	attrParts := make([][]byte, 0, len(attrs))
	for _, a := range attrs {
		a = strings.TrimSpace(a)
		if a != "" {
			attrParts = append(attrParts, berOctetString(a))
		}
	}
	id := c.nextID()
	searchReq := berTLV(ldapAppSearchRequest, berConcat(
		berOctetString(baseDN),    // baseObject
		berEnum(2),                // wholeSubtree
		berEnum(0),                // neverDerefAliases
		berInt(0),                 // sizeLimit (server default)
		berInt(20),                // timeLimit (seconds)
		berBool(false),            // typesOnly
		filterBER,                 // filter
		berSequence(attrParts...), // attributes
	))
	if err := c.writeMessage(id, searchReq); err != nil {
		return nil, fmt.Errorf("LDAP Search 发送失败: %w", err)
	}

	var entries []ldapEntry
	for {
		gotID, opTag, opVal, err := c.readMessage()
		if err != nil {
			return nil, fmt.Errorf("LDAP Search 响应读取失败: %w", err)
		}
		if gotID != id {
			continue
		}
		switch opTag {
		case ldapAppSearchResEntry:
			if len(entries) >= orgConnectorMaxLDAPEntries {
				continue
			}
			entry, err := parseLDAPSearchEntry(opVal)
			if err != nil {
				return nil, err
			}
			entries = append(entries, entry)
		case ldapAppSearchResRef:
			// Ignore LDAP referrals (common in multi-domain AD forests).
			continue
		case ldapAppSearchResDone:
			code, diag, err := parseLDAPResult(opVal)
			if err != nil {
				return nil, err
			}
			// 0 = success, 4 = sizeLimitExceeded (accept returned entries).
			if code != 0 && code != 4 {
				if diag != "" {
					return nil, fmt.Errorf("LDAP 查询失败 (code=%d): %s", code, diag)
				}
				return nil, fmt.Errorf("LDAP 查询失败 (code=%d)", code)
			}
			return entries, nil
		default:
			return nil, fmt.Errorf("收到意外的 LDAP Search 响应标签 0x%02x", opTag)
		}
	}
}

func parseLDAPSearchEntry(val []byte) (ldapEntry, error) {
	dnTag, dnVal, rest, err := berParseElement(val)
	if err != nil || dnTag != berTagOctetString {
		return ldapEntry{}, errors.New("invalid SearchResultEntry objectName")
	}
	entry := ldapEntry{
		DN:    string(dnVal),
		Attrs: map[string][]string{},
	}
	if len(rest) == 0 {
		return entry, nil
	}
	attrsTag, attrsVal, _, err := berParseElement(rest)
	if err != nil || attrsTag != berTagSequence {
		return ldapEntry{}, errors.New("invalid SearchResultEntry attributes")
	}
	cur := attrsVal
	for len(cur) > 0 {
		paTag, paVal, next, err := berParseElement(cur)
		if err != nil || paTag != berTagSequence {
			return ldapEntry{}, errors.New("invalid PartialAttribute")
		}
		cur = next
		typeTag, typeVal, paRest, err := berParseElement(paVal)
		if err != nil || typeTag != berTagOctetString {
			continue
		}
		attrName := strings.ToLower(strings.TrimSpace(string(typeVal)))
		valsTag, valsBody, _, err := berParseElement(paRest)
		if err != nil || valsTag != berTagSet {
			continue
		}
		vc := valsBody
		for len(vc) > 0 {
			vTag, vVal, vNext, err := berParseElement(vc)
			if err != nil {
				break
			}
			vc = vNext
			if vTag == berTagOctetString {
				entry.Attrs[attrName] = append(entry.Attrs[attrName], string(vVal))
			}
		}
	}
	return entry, nil
}

func (c *ldapConn) Unbind() {
	id := c.nextID()
	_ = c.writeMessage(id, berTLV(ldapAppUnbindRequest, nil))
}

func (c *ldapConn) Close() error {
	c.Unbind()
	return c.conn.Close()
}

// splitLDAPDN splits an RFC 4514 DN into RDN components, respecting backslash escapes.
func splitLDAPDN(dn string) []string {
	var parts []string
	var cur strings.Builder
	escaped := false
	for i := 0; i < len(dn); i++ {
		ch := dn[i]
		if escaped {
			cur.WriteByte(ch)
			escaped = false
			continue
		}
		if ch == '\\' {
			cur.WriteByte(ch)
			escaped = true
			continue
		}
		if ch == ',' {
			if p := strings.TrimSpace(cur.String()); p != "" {
				parts = append(parts, p)
			}
			cur.Reset()
			continue
		}
		cur.WriteByte(ch)
	}
	if p := strings.TrimSpace(cur.String()); p != "" {
		parts = append(parts, p)
	}
	return parts
}

func normalizeLDAPDN(dn string) string {
	parts := splitLDAPDN(dn)
	for i, p := range parts {
		parts[i] = strings.ToLower(strings.TrimSpace(p))
	}
	return strings.Join(parts, ",")
}

func ldapRDNValue(rdn string) string {
	if idx := strings.IndexByte(rdn, '='); idx >= 0 && idx+1 < len(rdn) {
		return strings.TrimSpace(rdn[idx+1:])
	}
	return strings.TrimSpace(rdn)
}

func ldapDeptExternalID(normDN string) string {
	ext := "ldap:" + normDN
	if utf8.RuneCountInString(ext) <= 120 {
		return ext
	}
	sum := sha256.Sum256([]byte(normDN))
	return "ldap:" + hex.EncodeToString(sum[:16])
}

func pullLDAPDirectory(ctx context.Context, cfg OrgConnectorConfig, opts orgConnectorNetOpts) (store.OrgDirectorySyncPayload, error) {
	cfg, _, err := mergeAndValidateConnectorConfig(store.OrgSyncProviderLDAP, cfg.EndpointURL, cfg, nil, opts)
	if err != nil {
		return store.OrgDirectorySyncPayload{}, err
	}
	conn, err := dialLDAP(ctx, cfg.EndpointURL, cfg.InsecureSkipVerify, opts)
	if err != nil {
		return store.OrgDirectorySyncPayload{}, err
	}
	defer conn.Close()

	if err := conn.Bind(cfg.BindDN, cfg.BindPassword); err != nil {
		return store.OrgDirectorySyncPayload{}, err
	}

	// 1. Fetch OUs / Departments
	ouEntries, err := conn.Search(cfg.BaseDN, cfg.DeptFilter, []string{cfg.DeptAttr, "ou", "cn", "name"})
	if err != nil {
		return store.OrgDirectorySyncPayload{}, err
	}
	normBaseDN := normalizeLDAPDN(cfg.BaseDN)

	type ouNode struct {
		normDN string
		parts  []string
		extID  string
		name   string
	}
	ouByNormDN := map[string]ouNode{}
	ouList := make([]ouNode, 0, len(ouEntries))
	for _, entry := range ouEntries {
		if len(ouList) >= orgConnectorMaxDepts {
			break
		}
		normDN := normalizeLDAPDN(entry.DN)
		if normDN == "" || normDN == normBaseDN {
			continue
		}
		if _, dup := ouByNormDN[normDN]; dup {
			continue
		}
		parts := splitLDAPDN(entry.DN)
		name := entry.first(cfg.DeptAttr, "ou", "cn", "name")
		if name == "" && len(parts) > 0 {
			name = ldapRDNValue(parts[0])
		}
		if name == "" {
			continue
		}
		node := ouNode{
			normDN: normDN,
			parts:  parts,
			extID:  ldapDeptExternalID(normDN),
			name:   name,
		}
		ouByNormDN[normDN] = node
		ouList = append(ouList, node)
	}

	// Sort shallowest DN first so parent OUs appear before child OUs.
	sort.Slice(ouList, func(i, j int) bool {
		if len(ouList[i].parts) != len(ouList[j].parts) {
			return len(ouList[i].parts) < len(ouList[j].parts)
		}
		return ouList[i].normDN < ouList[j].normDN
	})

	payload := store.OrgDirectorySyncPayload{}
	deptExtSet := map[string]bool{}
	deptByNameLower := map[string]string{}
	for i, node := range ouList {
		parentExt := ""
		for pIdx := 1; pIdx < len(node.parts); pIdx++ {
			candNorm := normalizeLDAPDN(strings.Join(node.parts[pIdx:], ","))
			if parentNode, ok := ouByNormDN[candNorm]; ok {
				parentExt = parentNode.extID
				break
			}
		}
		payload.Departments = append(payload.Departments, store.OrgSyncDeptInput{
			ExternalID:       node.extID,
			ParentExternalID: parentExt,
			Name:             node.name,
			SortOrder:        i + 1,
		})
		deptExtSet[node.extID] = true
		lowerName := strings.ToLower(strings.TrimSpace(node.name))
		if _, exists := deptByNameLower[lowerName]; !exists {
			deptByNameLower[lowerName] = node.extID
		}
	}

	ensureAttrDept := func(deptName string) string {
		deptName = strings.TrimSpace(deptName)
		if deptName == "" {
			return ""
		}
		if ext, ok := deptByNameLower[strings.ToLower(deptName)]; ok {
			return ext
		}
		if len(payload.Departments) >= orgConnectorMaxDepts {
			return ""
		}
		ext := ldapDeptExternalID("attr:" + strings.ToLower(deptName))
		if !deptExtSet[ext] {
			deptExtSet[ext] = true
			deptByNameLower[strings.ToLower(deptName)] = ext
			payload.Departments = append(payload.Departments, store.OrgSyncDeptInput{
				ExternalID: ext,
				Name:       deptName,
				SortOrder:  len(payload.Departments) + 1,
			})
		}
		return ext
	}

	// 2. Fetch Users
	userAttrs := []string{cfg.EmailAttr, cfg.NameAttr, cfg.DeptAttr, "mail", "userPrincipalName", "cn", "displayName", "ou", "department"}
	userEntries, err := conn.Search(cfg.BaseDN, cfg.UserFilter, userAttrs)
	if err != nil {
		return store.OrgDirectorySyncPayload{}, err
	}

	memberIdxByEmail := map[string]int{}
	for _, entry := range userEntries {
		email := entry.first(cfg.EmailAttr, "mail", "userPrincipalName")
		email = strings.ToLower(strings.TrimSpace(email))
		if email == "" || !strings.Contains(email, "@") {
			continue
		}
		name := entry.first(cfg.NameAttr, "displayName", "cn")
		var deptIDs []string
		seenDept := map[string]bool{}
		addDept := func(ext string) {
			if ext != "" && deptExtSet[ext] && !seenDept[ext] {
				seenDept[ext] = true
				deptIDs = append(deptIDs, ext)
			}
		}

		// Match nearest ancestor OU from user's DN.
		uParts := splitLDAPDN(entry.DN)
		for pIdx := 1; pIdx < len(uParts); pIdx++ {
			candNorm := normalizeLDAPDN(strings.Join(uParts[pIdx:], ","))
			if parentNode, ok := ouByNormDN[candNorm]; ok {
				addDept(parentNode.extID)
				break
			}
		}
		// Also match explicit dept attribute (e.g. ou / department) when present.
		for _, rawDept := range entry.all(cfg.DeptAttr) {
			rawDept = strings.TrimSpace(rawDept)
			if rawDept == "" {
				continue
			}
			if ext, ok := deptByNameLower[strings.ToLower(rawDept)]; ok {
				addDept(ext)
			} else if len(deptIDs) == 0 {
				addDept(ensureAttrDept(rawDept))
			}
		}
		if len(deptIDs) == 0 && !strings.EqualFold(cfg.DeptAttr, "department") {
			if rawDept := entry.first("department"); rawDept != "" {
				addDept(ensureAttrDept(rawDept))
			}
		}

		if idx, exists := memberIdxByEmail[email]; exists {
			for _, d := range deptIDs {
				payload.Members[idx].DepartmentExternalIDs = append(payload.Members[idx].DepartmentExternalIDs, d)
			}
			if payload.Members[idx].Name == "" && name != "" {
				payload.Members[idx].Name = name
			}
		} else {
			memberIdxByEmail[email] = len(payload.Members)
			payload.Members = append(payload.Members, store.OrgSyncMemberInput{
				Email:                 email,
				Name:                  name,
				DepartmentExternalIDs: deptIDs,
			})
		}
	}

	return payload, nil
}

// ============================================================================
// WeCom (企业微信) Active Pull Connector
// ============================================================================

func fetchConnectorJSON(ctx context.Context, client *http.Client, method, rawURL string, reqBody any, dst any) error {
	var bodyReader io.Reader
	if reqBody != nil {
		raw, err := json.Marshal(reqBody)
		if err != nil {
			return err
		}
		bodyReader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, rawURL, bodyReader)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if reqBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, orgConnectorMaxHTTPBody+1))
	if err != nil {
		return err
	}
	if len(data) > orgConnectorMaxHTTPBody {
		return errors.New("上游目录响应体过大")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("上游目录接口返回 HTTP %d", resp.StatusCode)
	}
	if err := json.Unmarshal(data, dst); err != nil {
		return fmt.Errorf("解析上游目录 JSON 失败: %w", err)
	}
	return nil
}

func pullWeComDirectory(ctx context.Context, cfg OrgConnectorConfig, opts orgConnectorNetOpts) (store.OrgDirectorySyncPayload, error) {
	cfg, baseURL, err := mergeAndValidateConnectorConfig(store.OrgSyncProviderWeCom, cfg.EndpointURL, cfg, nil, opts)
	if err != nil {
		return store.OrgDirectorySyncPayload{}, err
	}
	client := orgConnectorHTTPClient(opts)

	// 1. Access token
	tokenURL := fmt.Sprintf("%s/cgi-bin/gettoken?corpid=%s&corpsecret=%s",
		baseURL, url.QueryEscape(cfg.CorpID), url.QueryEscape(cfg.CorpSecret))
	var tokenResp struct {
		ErrCode     int    `json:"errcode"`
		ErrMsg      string `json:"errmsg"`
		AccessToken string `json:"access_token"`
	}
	if err := fetchConnectorJSON(ctx, client, http.MethodGet, tokenURL, nil, &tokenResp); err != nil {
		return store.OrgDirectorySyncPayload{}, err
	}
	if tokenResp.ErrCode != 0 || strings.TrimSpace(tokenResp.AccessToken) == "" {
		return store.OrgDirectorySyncPayload{}, fmt.Errorf("企业微信获取 access_token 失败 (errcode=%d): %s", tokenResp.ErrCode, tokenResp.ErrMsg)
	}

	// 2. Department list
	deptURL := fmt.Sprintf("%s/cgi-bin/department/list?access_token=%s",
		baseURL, url.QueryEscape(tokenResp.AccessToken))
	var deptResp struct {
		ErrCode    int    `json:"errcode"`
		ErrMsg     string `json:"errmsg"`
		Department []struct {
			ID       int64  `json:"id"`
			Name     string `json:"name"`
			ParentID int64  `json:"parentid"`
			Order    int    `json:"order"`
		} `json:"department"`
	}
	if err := fetchConnectorJSON(ctx, client, http.MethodGet, deptURL, nil, &deptResp); err != nil {
		return store.OrgDirectorySyncPayload{}, err
	}
	if deptResp.ErrCode != 0 {
		return store.OrgDirectorySyncPayload{}, fmt.Errorf("企业微信拉取部门失败 (errcode=%d): %s", deptResp.ErrCode, deptResp.ErrMsg)
	}

	deptIDExists := make(map[int64]bool, len(deptResp.Department))
	for _, d := range deptResp.Department {
		if d.ID > 0 && strings.TrimSpace(d.Name) != "" {
			deptIDExists[d.ID] = true
		}
	}
	payload := store.OrgDirectorySyncPayload{}
	deptExtSet := map[string]bool{}
	for _, d := range deptResp.Department {
		if len(payload.Departments) >= orgConnectorMaxDepts {
			break
		}
		name := strings.TrimSpace(d.Name)
		if d.ID <= 0 || name == "" {
			continue
		}
		extID := fmt.Sprintf("wecom-dept:%d", d.ID)
		parentExt := ""
		if d.ParentID > 0 && d.ParentID != d.ID && deptIDExists[d.ParentID] {
			parentExt = fmt.Sprintf("wecom-dept:%d", d.ParentID)
		}
		payload.Departments = append(payload.Departments, store.OrgSyncDeptInput{
			ExternalID:       extID,
			ParentExternalID: parentExt,
			Name:             name,
			SortOrder:        d.Order,
		})
		deptExtSet[extID] = true
	}

	// 3. User list
	userURL := fmt.Sprintf("%s/cgi-bin/user/list?access_token=%s&department_id=%d&fetch_child=1",
		baseURL, url.QueryEscape(tokenResp.AccessToken), cfg.RootDeptID)
	var userResp struct {
		ErrCode  int    `json:"errcode"`
		ErrMsg   string `json:"errmsg"`
		UserList []struct {
			UserID         string  `json:"userid"`
			Name           string  `json:"name"`
			Email          string  `json:"email"`
			BizMail        string  `json:"biz_mail"`
			Department     []int64 `json:"department"`
			IsLeaderInDept []int   `json:"is_leader_in_dept"`
			Status         int     `json:"status"`
		} `json:"userlist"`
	}
	if err := fetchConnectorJSON(ctx, client, http.MethodGet, userURL, nil, &userResp); err != nil {
		return store.OrgDirectorySyncPayload{}, err
	}
	if userResp.ErrCode != 0 {
		return store.OrgDirectorySyncPayload{}, fmt.Errorf("企业微信拉取成员失败 (errcode=%d): %s", userResp.ErrCode, userResp.ErrMsg)
	}

	memberIdxByEmail := map[string]int{}
	for _, u := range userResp.UserList {
		// Status 2 = disabled, 5 = departed.
		if u.Status == 2 || u.Status == 5 {
			continue
		}
		email := strings.ToLower(strings.TrimSpace(u.Email))
		if !strings.Contains(email, "@") {
			email = strings.ToLower(strings.TrimSpace(u.BizMail))
		}
		if !strings.Contains(email, "@") {
			continue
		}
		var deptExts, leaderExts []string
		for i, did := range u.Department {
			ext := fmt.Sprintf("wecom-dept:%d", did)
			if !deptExtSet[ext] {
				continue
			}
			deptExts = append(deptExts, ext)
			if i < len(u.IsLeaderInDept) && u.IsLeaderInDept[i] == 1 {
				leaderExts = append(leaderExts, ext)
			}
		}
		if idx, exists := memberIdxByEmail[email]; exists {
			payload.Members[idx].DepartmentExternalIDs = append(payload.Members[idx].DepartmentExternalIDs, deptExts...)
			payload.Members[idx].LeaderDepartmentExternalIDs = append(payload.Members[idx].LeaderDepartmentExternalIDs, leaderExts...)
		} else {
			memberIdxByEmail[email] = len(payload.Members)
			payload.Members = append(payload.Members, store.OrgSyncMemberInput{
				Email:                       email,
				Name:                        strings.TrimSpace(u.Name),
				DepartmentExternalIDs:       deptExts,
				LeaderDepartmentExternalIDs: leaderExts,
			})
		}
	}

	return payload, nil
}

// ============================================================================
// DingTalk (钉钉) Active Pull Connector
// ============================================================================

func pullDingTalkDirectory(ctx context.Context, cfg OrgConnectorConfig, opts orgConnectorNetOpts) (store.OrgDirectorySyncPayload, error) {
	cfg, baseURL, err := mergeAndValidateConnectorConfig(store.OrgSyncProviderDingTalk, cfg.EndpointURL, cfg, nil, opts)
	if err != nil {
		return store.OrgDirectorySyncPayload{}, err
	}
	client := orgConnectorHTTPClient(opts)

	// 1. Access token
	tokenURL := fmt.Sprintf("%s/gettoken?appkey=%s&appsecret=%s",
		baseURL, url.QueryEscape(cfg.AppKey), url.QueryEscape(cfg.AppSecret))
	var tokenResp struct {
		ErrCode     int    `json:"errcode"`
		ErrMsg      string `json:"errmsg"`
		AccessToken string `json:"access_token"`
	}
	if err := fetchConnectorJSON(ctx, client, http.MethodGet, tokenURL, nil, &tokenResp); err != nil {
		return store.OrgDirectorySyncPayload{}, err
	}
	if tokenResp.ErrCode != 0 || strings.TrimSpace(tokenResp.AccessToken) == "" {
		return store.OrgDirectorySyncPayload{}, fmt.Errorf("钉钉获取 access_token 失败 (errcode=%d): %s", tokenResp.ErrCode, tokenResp.ErrMsg)
	}
	tokenQuery := url.QueryEscape(tokenResp.AccessToken)

	// 2. Recursive BFS for departments with cycle guard and depth limit
	type dingDept struct {
		DeptID   int64  `json:"dept_id"`
		Name     string `json:"name"`
		ParentID int64  `json:"parent_id"`
	}
	type bfsItem struct {
		deptID int64
		depth  int
	}
	visited := map[int64]bool{cfg.RootDeptID: true}
	queue := []bfsItem{{deptID: cfg.RootDeptID, depth: 0}}
	discovered := make([]dingDept, 0)
	discoveredMap := map[int64]dingDept{}

	listSubURL := fmt.Sprintf("%s/topapi/v2/department/listsub?access_token=%s", baseURL, tokenQuery)
	for len(queue) > 0 && len(discovered) < orgConnectorMaxDepts {
		cur := queue[0]
		queue = queue[1:]
		if cur.depth >= orgConnectorMaxDeptDepth {
			continue
		}
		var subResp struct {
			ErrCode int        `json:"errcode"`
			ErrMsg  string     `json:"errmsg"`
			Result  []dingDept `json:"result"`
		}
		if err := fetchConnectorJSON(ctx, client, http.MethodPost, listSubURL, map[string]any{"dept_id": cur.deptID}, &subResp); err != nil {
			return store.OrgDirectorySyncPayload{}, err
		}
		if subResp.ErrCode != 0 {
			return store.OrgDirectorySyncPayload{}, fmt.Errorf("钉钉拉取子部门失败 (dept=%d, errcode=%d): %s", cur.deptID, subResp.ErrCode, subResp.ErrMsg)
		}
		for _, d := range subResp.Result {
			if d.DeptID <= 0 || strings.TrimSpace(d.Name) == "" {
				continue
			}
			if _, exists := discoveredMap[d.DeptID]; !exists {
				discoveredMap[d.DeptID] = d
				discovered = append(discovered, d)
				if len(discovered) >= orgConnectorMaxDepts {
					break
				}
			}
			if !visited[d.DeptID] {
				visited[d.DeptID] = true
				queue = append(queue, bfsItem{deptID: d.DeptID, depth: cur.depth + 1})
			}
		}
	}

	payload := store.OrgDirectorySyncPayload{}
	deptExtSet := map[string]bool{}
	for i, d := range discovered {
		extID := fmt.Sprintf("dingtalk-dept:%d", d.DeptID)
		parentExt := ""
		if d.ParentID > 0 && d.ParentID != d.DeptID {
			if _, ok := discoveredMap[d.ParentID]; ok {
				parentExt = fmt.Sprintf("dingtalk-dept:%d", d.ParentID)
			}
		}
		payload.Departments = append(payload.Departments, store.OrgSyncDeptInput{
			ExternalID:       extID,
			ParentExternalID: parentExt,
			Name:             strings.TrimSpace(d.Name),
			SortOrder:        i + 1,
		})
		deptExtSet[extID] = true
	}

	// 3. Paginate users per department (root + all discovered departments) and deduplicate
	deptQueryOrder := make([]int64, 0, len(discovered)+1)
	deptQuerySeen := map[int64]bool{}
	addQueryDept := func(id int64) {
		if id > 0 && !deptQuerySeen[id] {
			deptQuerySeen[id] = true
			deptQueryOrder = append(deptQueryOrder, id)
		}
	}
	addQueryDept(cfg.RootDeptID)
	for _, d := range discovered {
		addQueryDept(d.DeptID)
	}

	userListURL := fmt.Sprintf("%s/topapi/v2/user/list?access_token=%s", baseURL, tokenQuery)
	memberIdxByEmail := map[string]int{}
	for _, deptID := range deptQueryOrder {
		var cursor int64 = 0
		for page := 0; page < orgConnectorMaxDingPages; page++ {
			var uResp struct {
				ErrCode int    `json:"errcode"`
				ErrMsg  string `json:"errmsg"`
				Result  struct {
					HasMore    bool  `json:"has_more"`
					NextCursor int64 `json:"next_cursor"`
					List       []struct {
						UserID     string  `json:"userid"`
						Name       string  `json:"name"`
						Email      string  `json:"email"`
						OrgEmail   string  `json:"org_email"`
						DeptIDList []int64 `json:"dept_id_list"`
						Leader     bool    `json:"leader"`
						Active     *bool   `json:"active"`
					} `json:"list"`
				} `json:"result"`
			}
			reqBody := map[string]any{
				"dept_id": deptID,
				"cursor":  cursor,
				"size":    100,
			}
			if err := fetchConnectorJSON(ctx, client, http.MethodPost, userListURL, reqBody, &uResp); err != nil {
				return store.OrgDirectorySyncPayload{}, err
			}
			if uResp.ErrCode != 0 {
				return store.OrgDirectorySyncPayload{}, fmt.Errorf("钉钉拉取部门成员失败 (dept=%d, errcode=%d): %s", deptID, uResp.ErrCode, uResp.ErrMsg)
			}
			for _, u := range uResp.Result.List {
				if u.Active != nil && !*u.Active {
					continue
				}
				email := strings.ToLower(strings.TrimSpace(u.Email))
				if !strings.Contains(email, "@") {
					email = strings.ToLower(strings.TrimSpace(u.OrgEmail))
				}
				if !strings.Contains(email, "@") {
					continue
				}
				var deptExts, leaderExts []string
				for _, did := range u.DeptIDList {
					ext := fmt.Sprintf("dingtalk-dept:%d", did)
					if deptExtSet[ext] {
						deptExts = append(deptExts, ext)
					}
				}
				curDeptExt := fmt.Sprintf("dingtalk-dept:%d", deptID)
				if deptExtSet[curDeptExt] {
					if len(deptExts) == 0 {
						deptExts = append(deptExts, curDeptExt)
					}
					if u.Leader {
						leaderExts = append(leaderExts, curDeptExt)
					}
				}
				if idx, exists := memberIdxByEmail[email]; exists {
					payload.Members[idx].DepartmentExternalIDs = append(payload.Members[idx].DepartmentExternalIDs, deptExts...)
					payload.Members[idx].LeaderDepartmentExternalIDs = append(payload.Members[idx].LeaderDepartmentExternalIDs, leaderExts...)
					if payload.Members[idx].Name == "" && strings.TrimSpace(u.Name) != "" {
						payload.Members[idx].Name = strings.TrimSpace(u.Name)
					}
				} else {
					memberIdxByEmail[email] = len(payload.Members)
					payload.Members = append(payload.Members, store.OrgSyncMemberInput{
						Email:                       email,
						Name:                        strings.TrimSpace(u.Name),
						DepartmentExternalIDs:       deptExts,
						LeaderDepartmentExternalIDs: leaderExts,
					})
				}
			}
			if !uResp.Result.HasMore || uResp.Result.NextCursor <= cursor {
				break
			}
			cursor = uResp.Result.NextCursor
		}
	}

	return payload, nil
}

// ============================================================================
// On-Demand Pull HTTP Handler & Background Scheduled Sweeper
// ============================================================================

// pullOrgDirectorySync handles POST /api/workspaces/{wsId}/org/sync-sources/{sourceId}/pull.
func (s *Server) pullOrgDirectorySync(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	sourceID, ok := s.parsePositivePathID(w, r, "sourceId")
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

	var in struct {
		DryRun       bool  `json:"dryRun"`
		PruneMissing *bool `json:"pruneMissing"`
	}
	if r.Body != nil {
		raw, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, "bad_request", "请求体读取失败")
			return
		}
		if len(bytes.TrimSpace(raw)) > 0 {
			if err := json.Unmarshal(raw, &in); err != nil {
				httpx.Error(w, http.StatusBadRequest, "bad_request", "无效的 JSON 格式")
				return
			}
		}
	}

	// Verify workspace admin permission & source ownership before reading sealed credentials.
	sources, _, err := s.Store.ListOrgSyncState(r.Context(), guard, wsID)
	if err != nil {
		s.orgError(w, r, err)
		return
	}
	owned := false
	for _, src := range sources {
		if src.ID == sourceID {
			owned = true
			break
		}
	}
	if !owned {
		httpx.Error(w, http.StatusNotFound, "not_found", "目录同步源不存在")
		return
	}

	fullSrc, err := s.Store.GetOrgSyncSourceSystem(r.Context(), sourceID)
	if err != nil || fullSrc.WorkspaceID != wsID {
		s.orgError(w, r, err)
		return
	}
	if !store.IsPullOrgSyncProvider(fullSrc.Provider) {
		httpx.Error(w, http.StatusBadRequest, "unsupported_provider", "仅 LDAP、企业微信和钉钉同步源支持主动拉取")
		return
	}
	if len(fullSrc.ConnectorConfigEnc) == 0 {
		httpx.Error(w, http.StatusBadRequest, "connector_not_configured", "请先保存连接器凭证配置后再执行主动拉取")
		return
	}

	cfg, err := openOrgConnectorConfig(s.orgConnectorSecretKey(), wsID, sourceID, fullSrc.ConnectorConfigEnc)
	if err != nil {
		s.Log.Error("org connector config decrypt failed", "wsId", wsID, "sourceId", sourceID, "err", err)
		httpx.Error(w, http.StatusInternalServerError, "decrypt_failed", "连接器凭证解密失败，请重新保存凭证")
		return
	}
	if fullSrc.EndpointURL != "" {
		cfg.EndpointURL = fullSrc.EndpointURL
	}

	payload, err := pullOrgDirectory(r.Context(), fullSrc.Provider, cfg, s.orgConnectorNetOpts())
	if err != nil {
		if errors.Is(err, errBlockedAddress) || strings.Contains(err.Error(), errBlockedAddress.Error()) {
			httpx.Error(w, http.StatusBadRequest, "blocked_address", "连接器地址被安全策略拦截")
			return
		}
		httpx.Error(w, http.StatusBadGateway, "connector_pull_failed", "外部目录拉取失败："+err.Error())
		return
	}
	payload.DryRun = in.DryRun
	if in.PruneMissing != nil {
		payload.PruneMissing = in.PruneMissing
	}

	run, err := s.Store.RunOrgDirectorySyncWithModeGuarded(r.Context(), guard, wsID, sourceID, store.OrgSyncTriggerPull, payload)
	if err != nil {
		if errors.Is(err, store.ErrConflict) && run.ErrorMessage != "" {
			httpx.Error(w, http.StatusConflict, "invalid_payload", run.ErrorMessage)
			return
		}
		s.orgError(w, r, err)
		return
	}

	s.recordAudit(r, wsID, "org.sync_pulled", "org_sync_source", sourceID, fullSrc.Name, map[string]any{
		"provider":           fullSrc.Provider,
		"dryRun":             in.DryRun,
		"fetchedDepartments": len(payload.Departments),
		"fetchedGroups":      len(payload.Groups),
		"fetchedMembers":     len(payload.Members),
		"departmentsCreated": run.DepartmentsCreated,
		"departmentsUpdated": run.DepartmentsUpdated,
		"departmentsRemoved": run.DepartmentsRemoved,
		"membersLinked":      run.MembersLinked,
		"membersInvited":     run.MembersInvited,
	})

	httpx.JSON(w, http.StatusOK, map[string]any{
		"run": run,
		"fetched": map[string]int{
			"departments": len(payload.Departments),
			"groups":      len(payload.Groups),
			"members":     len(payload.Members),
		},
	})
}

// SweepScheduledOrgSyncs discovers enabled LDAP/WeCom/DingTalk connectors whose
// scheduled interval is due, pulls each directory, runs a transactional sync
// with triggerMode="scheduled", and updates last_auto_sync_at.
func SweepScheduledOrgSyncs(ctx context.Context, st store.Store, secret []byte, log *slog.Logger) int {
	if st == nil {
		return 0
	}
	now := time.Now().UTC()
	if orgSyncSweeperNow != nil {
		now = orgSyncSweeperNow().UTC()
	}
	due, err := st.ListDueScheduledOrgSyncSources(ctx, now)
	if err != nil {
		if log != nil {
			log.Warn("scheduled org sync list failed", "err", err)
		}
		return 0
	}
	if len(due) == 0 {
		return 0
	}
	key := orgConnectorSecretKey(secret)
	opts := defaultOrgConnectorNetOpts()
	synced := 0
	for _, src := range due {
		if ctx.Err() != nil {
			break
		}
		pullCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
		cfg, err := openOrgConnectorConfig(key, src.WorkspaceID, src.ID, src.ConnectorConfigEnc)
		if err != nil {
			cancel()
			if log != nil {
				log.Error("scheduled org sync decrypt failed", "sourceId", src.ID, "workspaceId", src.WorkspaceID, "err", err)
			}
			_ = st.MarkOrgSyncAutoSyncAt(ctx, src.ID, now)
			continue
		}
		if src.EndpointURL != "" {
			cfg.EndpointURL = src.EndpointURL
		}
		payload, err := pullOrgDirectory(pullCtx, src.Provider, cfg, opts)
		if err != nil {
			cancel()
			if log != nil {
				log.Warn("scheduled org sync pull failed", "sourceId", src.ID, "workspaceId", src.WorkspaceID, "provider", src.Provider, "err", err)
			}
			_ = st.MarkOrgSyncAutoSyncAt(ctx, src.ID, now)
			continue
		}
		run, err := st.RunOrgDirectorySyncSystem(pullCtx, src.ID, store.OrgSyncTriggerScheduled, payload)
		cancel()
		_ = st.MarkOrgSyncAutoSyncAt(ctx, src.ID, now)
		if err != nil {
			if log != nil {
				log.Warn("scheduled org sync apply failed", "sourceId", src.ID, "workspaceId", src.WorkspaceID, "provider", src.Provider, "err", err)
			}
			continue
		}
		if log != nil {
			log.Info("scheduled org sync completed",
				"sourceId", src.ID,
				"workspaceId", src.WorkspaceID,
				"provider", src.Provider,
				"departmentsCreated", run.DepartmentsCreated,
				"departmentsUpdated", run.DepartmentsUpdated,
				"membersLinked", run.MembersLinked,
				"membersInvited", run.MembersInvited,
			)
		}
		synced++
	}
	return synced
}
