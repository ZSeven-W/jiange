package api

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// --- Minimal CBOR encoder for tests (builds real RFC 8949 attestationObjects & COSE keys) ---

func cborAppendHead(dst []byte, major byte, n uint64) []byte {
	prefix := major << 5
	switch {
	case n <= 23:
		return append(dst, prefix|byte(n))
	case n <= 0xff:
		return append(dst, prefix|24, byte(n))
	case n <= 0xffff:
		var b [2]byte
		binary.BigEndian.PutUint16(b[:], uint16(n))
		return append(append(dst, prefix|25), b[:]...)
	case n <= 0xffffffff:
		var b [4]byte
		binary.BigEndian.PutUint32(b[:], uint32(n))
		return append(append(dst, prefix|26), b[:]...)
	default:
		var b [8]byte
		binary.BigEndian.PutUint64(b[:], n)
		return append(append(dst, prefix|27), b[:]...)
	}
}

func cborEncodeInt(v int64) []byte {
	if v >= 0 {
		return cborAppendHead(nil, 0, uint64(v))
	}
	return cborAppendHead(nil, 1, uint64(-1-v))
}

func cborEncodeBytes(b []byte) []byte {
	out := cborAppendHead(nil, 2, uint64(len(b)))
	return append(out, b...)
}

func cborEncodeText(s string) []byte {
	out := cborAppendHead(nil, 3, uint64(len(s)))
	return append(out, s...)
}

func cborEncodeMapPairs(pairs [][2][]byte) []byte {
	out := cborAppendHead(nil, 5, uint64(len(pairs)))
	for _, kv := range pairs {
		out = append(out, kv[0]...)
		out = append(out, kv[1]...)
	}
	return out
}

func padBigInt32(n *big.Int) []byte {
	raw := n.Bytes()
	if len(raw) == 32 {
		return raw
	}
	out := make([]byte, 32)
	copy(out[32-len(raw):], raw)
	return out
}

func encodeCOSEES256(pub *ecdsa.PublicKey) []byte {
	return cborEncodeMapPairs([][2][]byte{
		{cborEncodeInt(1), cborEncodeInt(2)},                     // kty: EC2
		{cborEncodeInt(3), cborEncodeInt(-7)},                    // alg: ES256
		{cborEncodeInt(-1), cborEncodeInt(1)},                    // crv: P-256
		{cborEncodeInt(-2), cborEncodeBytes(padBigInt32(pub.X))}, // x
		{cborEncodeInt(-3), cborEncodeBytes(padBigInt32(pub.Y))}, // y
	})
}

func encodeCOSERS256(pub *rsa.PublicKey) []byte {
	eBytes := big.NewInt(int64(pub.E)).Bytes()
	return cborEncodeMapPairs([][2][]byte{
		{cborEncodeInt(1), cborEncodeInt(3)},                // kty: RSA
		{cborEncodeInt(3), cborEncodeInt(-257)},             // alg: RS256
		{cborEncodeInt(-1), cborEncodeBytes(pub.N.Bytes())}, // n
		{cborEncodeInt(-2), cborEncodeBytes(eBytes)},        // e
	})
}

func buildTestAttestationObject(rpID string, flags byte, signCount uint32, aaguid [16]byte, credID, cosePubKey []byte) []byte {
	rpHash := sha256.Sum256([]byte(rpID))
	var authData bytes.Buffer
	authData.Write(rpHash[:])
	authData.WriteByte(flags)
	_ = binary.Write(&authData, binary.BigEndian, signCount)
	if flags&webAuthnFlagAT != 0 {
		authData.Write(aaguid[:])
		_ = binary.Write(&authData, binary.BigEndian, uint16(len(credID)))
		authData.Write(credID)
		authData.Write(cosePubKey)
	}
	emptyMap := cborAppendHead(nil, 5, 0)
	return cborEncodeMapPairs([][2][]byte{
		{cborEncodeText("fmt"), cborEncodeText("none")},
		{cborEncodeText("attStmt"), emptyMap},
		{cborEncodeText("authData"), cborEncodeBytes(authData.Bytes())},
	})
}

func buildTestAssertionAuthData(rpID string, flags byte, signCount uint32) []byte {
	rpHash := sha256.Sum256([]byte(rpID))
	var authData bytes.Buffer
	authData.Write(rpHash[:])
	authData.WriteByte(flags)
	_ = binary.Write(&authData, binary.BigEndian, signCount)
	return authData.Bytes()
}

func signAssertionECDSA(t *testing.T, priv *ecdsa.PrivateKey, authData, clientDataJSON []byte) []byte {
	t.Helper()
	ch := sha256.Sum256(clientDataJSON)
	h := sha256.New()
	h.Write(authData)
	h.Write(ch[:])
	sig, err := ecdsa.SignASN1(rand.Reader, priv, h.Sum(nil))
	if err != nil {
		t.Fatal(err)
	}
	return sig
}

func signAssertionRSA(t *testing.T, priv *rsa.PrivateKey, authData, clientDataJSON []byte) []byte {
	t.Helper()
	ch := sha256.Sum256(clientDataJSON)
	h := sha256.New()
	h.Write(authData)
	h.Write(ch[:])
	sig, err := rsa.SignPKCS1v15(rand.Reader, priv, crypto.SHA256, h.Sum(nil))
	if err != nil {
		t.Fatal(err)
	}
	return sig
}

func newPasskeyTestServer(t *testing.T, st store.Store) (*Server, *httptest.Server, *time.Time, *sync.Mutex) {
	t.Helper()
	var clockMu sync.Mutex
	now := time.Date(2026, 11, 24, 14, 0, 0, 0, time.UTC)

	s := &Server{
		Store:      st,
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL: time.Hour,
		Iterations: 1000,
		Now: func() time.Time {
			clockMu.Lock()
			defer clockMu.Unlock()
			return now
		},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/auth/register", s.register)
	mux.HandleFunc("POST /api/auth/login", s.login)
	mux.HandleFunc("POST /api/auth/logout", s.logout)
	mux.HandleFunc("POST /api/auth/passkey/login/begin", s.beginPasskeyLogin)
	mux.HandleFunc("POST /api/auth/passkey/login/finish", s.finishPasskeyLogin)
	mux.Handle("GET /api/me", s.requireUser(http.HandlerFunc(s.me)))
	mux.Handle("GET /api/me/mfa", s.requireUser(http.HandlerFunc(s.getMyMFA)))
	mux.Handle("POST /api/me/mfa/setup", s.requireUser(http.HandlerFunc(s.setupMyMFA)))
	mux.Handle("POST /api/me/mfa/enable", s.requireUser(http.HandlerFunc(s.enableMyMFA)))
	mux.Handle("POST /api/me/mfa/disable", s.requireUser(http.HandlerFunc(s.disableMyMFA)))
	mux.Handle("GET /api/me/passkeys", s.requireUser(http.HandlerFunc(s.listMyPasskeys)))
	mux.Handle("DELETE /api/me/passkeys/{pid}", s.requireUser(http.HandlerFunc(s.deleteMyPasskey)))
	mux.Handle("POST /api/me/passkeys/register/begin", s.requireUser(http.HandlerFunc(s.beginPasskeyRegister)))
	mux.Handle("POST /api/me/passkeys/register/finish", s.requireUser(http.HandlerFunc(s.finishPasskeyRegister)))
	mux.Handle("PUT /api/workspaces/{wsId}/security-policy", s.requireUser(http.HandlerFunc(s.putWorkspaceSecurityPolicy)))
	mux.Handle("GET /api/workspaces/{wsId}/audit-logs", s.requireUser(http.HandlerFunc(s.listWorkspaceAuditLogs)))

	handler := httpx.Chain(mux,
		httpx.WithRequestID,
		httpx.Logger(s.Log),
		httpx.Recover(s.Log),
		httpx.SecurityHeaders,
		httpx.RequireJSON,
	)
	ts := httptest.NewServer(handler)
	t.Cleanup(ts.Close)
	return s, ts, &now, &clockMu
}

func passkeyJSONRequest(t *testing.T, client *http.Client, method, url, origin string, payload any) (*http.Response, []byte) {
	t.Helper()
	var body io.Reader
	if payload != nil {
		b, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, url, body)
	if err != nil {
		t.Fatal(err)
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp, raw
}

func makeClientDataJSON(t *testing.T, typ, challenge, origin string) []byte {
	t.Helper()
	b, err := json.Marshal(map[string]any{
		"type":        typ,
		"challenge":   challenge,
		"origin":      origin,
		"crossOrigin": false,
	})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestPasskeysES256AndRS256EndToEnd(t *testing.T) {
	st := store.NewMemory()
	_, ts, nowPtr, clockMu := newPasskeyTestServer(t, st)
	advance := func(d time.Duration) {
		clockMu.Lock()
		*nowPtr = nowPtr.Add(d)
		clockMu.Unlock()
	}

	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}

	// Register Alice.
	resp, raw := passkeyJSONRequest(t, client, "POST", ts.URL+"/api/auth/register", "", map[string]any{
		"email":    "alice-pk@example.com",
		"name":     "Alice PK",
		"password": "super-secret-password",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register = %d %s", resp.StatusCode, raw)
	}
	var regMe meResponse
	if err := json.Unmarshal(raw, &regMe); err != nil {
		t.Fatal(err)
	}

	// --- 1. Register ES256 (P-256) passkey ---
	ecKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ecCredID := []byte("es256-cred-id-0001")
	ecAAGUID := [16]byte{0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10}

	resp, raw = passkeyJSONRequest(t, client, "POST", ts.URL+"/api/me/passkeys/register/begin", ts.URL, map[string]any{})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("begin register ES256 = %d %s", resp.StatusCode, raw)
	}
	var createOpts webAuthnCreationOptions
	if err := json.Unmarshal(raw, &createOpts); err != nil {
		t.Fatal(err)
	}
	if createOpts.RP.ID != "127.0.0.1" || createOpts.Challenge == "" || createOpts.Attestation != "none" || len(createOpts.PubKeyCredParams) != 2 {
		t.Fatalf("unexpected creation options: %+v", createOpts)
	}

	ecClientData := makeClientDataJSON(t, "webauthn.create", createOpts.Challenge, ts.URL)
	ecAttObj := buildTestAttestationObject(createOpts.RP.ID, webAuthnFlagUP|webAuthnFlagAT, 1, ecAAGUID, ecCredID, encodeCOSEES256(&ecKey.PublicKey))
	ecCredB64 := base64.RawURLEncoding.EncodeToString(ecCredID)

	resp, raw = passkeyJSONRequest(t, client, "POST", ts.URL+"/api/me/passkeys/register/finish", ts.URL, map[string]any{
		"name":  "MacBook Touch ID",
		"id":    ecCredB64,
		"rawId": ecCredB64,
		"type":  "public-key",
		"response": map[string]any{
			"clientDataJSON":    base64.RawURLEncoding.EncodeToString(ecClientData),
			"attestationObject": base64.RawURLEncoding.EncodeToString(ecAttObj),
			"transports":        []string{"internal", "hybrid"},
		},
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("finish register ES256 = %d %s", resp.StatusCode, raw)
	}
	var ecSummary passkeySummaryDTO
	if err := json.Unmarshal(raw, &ecSummary); err != nil {
		t.Fatal(err)
	}
	if ecSummary.ID <= 0 || ecSummary.Name != "MacBook Touch ID" || ecSummary.CredentialID != ecCredB64 || ecSummary.AAGUID != "01020304-0506-0708-090a-0b0c0d0e0f10" {
		t.Fatalf("unexpected ES256 summary: %+v", ecSummary)
	}

	// --- 2. Register RS256 (RSA-2048) passkey (with signCount = 0 for synced-key behavior) ---
	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	rsaCredID := []byte("rs256-cred-id-0002")
	rsaCredB64 := base64.RawURLEncoding.EncodeToString(rsaCredID)

	resp, raw = passkeyJSONRequest(t, client, "POST", ts.URL+"/api/me/passkeys/register/begin", ts.URL, map[string]any{})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("begin register RS256 = %d %s", resp.StatusCode, raw)
	}
	var createOpts2 webAuthnCreationOptions
	if err := json.Unmarshal(raw, &createOpts2); err != nil {
		t.Fatal(err)
	}
	// Existing ES256 credential must appear in excludeCredentials.
	if len(createOpts2.ExcludeCredentials) != 1 || createOpts2.ExcludeCredentials[0].ID != ecCredB64 {
		t.Fatalf("expected excludeCredentials=[%s], got %+v", ecCredB64, createOpts2.ExcludeCredentials)
	}

	rsaClientData := makeClientDataJSON(t, "webauthn.create", createOpts2.Challenge, ts.URL)
	rsaAttObj := buildTestAttestationObject(createOpts2.RP.ID, webAuthnFlagUP|webAuthnFlagAT, 0, [16]byte{}, rsaCredID, encodeCOSERS256(&rsaKey.PublicKey))
	resp, raw = passkeyJSONRequest(t, client, "POST", ts.URL+"/api/me/passkeys/register/finish", ts.URL, map[string]any{
		"name":  "YubiKey 5C",
		"id":    rsaCredB64,
		"rawId": rsaCredB64,
		"type":  "public-key",
		"response": map[string]any{
			"clientDataJSON":    base64.RawURLEncoding.EncodeToString(rsaClientData),
			"attestationObject": base64.RawURLEncoding.EncodeToString(rsaAttObj),
			"transports":        []string{"usb", "nfc"},
		},
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("finish register RS256 = %d %s", resp.StatusCode, raw)
	}
	var rsaSummary passkeySummaryDTO
	if err := json.Unmarshal(raw, &rsaSummary); err != nil {
		t.Fatal(err)
	}

	// List passkeys returns both credentials.
	resp, raw = passkeyJSONRequest(t, client, "GET", ts.URL+"/api/me/passkeys", "", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list passkeys = %d %s", resp.StatusCode, raw)
	}
	var listResp struct {
		Passkeys []passkeySummaryDTO `json:"passkeys"`
	}
	if err := json.Unmarshal(raw, &listResp); err != nil {
		t.Fatal(err)
	}
	if len(listResp.Passkeys) != 2 {
		t.Fatalf("expected 2 passkeys, got %d", len(listResp.Passkeys))
	}

	// --- 3. Passwordless login with ES256 (email-scoped allowCredentials) ---
	loginJar1, _ := cookiejar.New(nil)
	loginClient1 := &http.Client{Jar: loginJar1}
	resp, raw = passkeyJSONRequest(t, loginClient1, "POST", ts.URL+"/api/auth/passkey/login/begin", ts.URL, map[string]any{
		"email": "alice-pk@example.com",
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("begin login ES256 = %d %s", resp.StatusCode, raw)
	}
	var reqOpts1 webAuthnRequestOptions
	if err := json.Unmarshal(raw, &reqOpts1); err != nil {
		t.Fatal(err)
	}
	if len(reqOpts1.AllowCredentials) != 2 || reqOpts1.RPID != "127.0.0.1" {
		t.Fatalf("unexpected login request options: %+v", reqOpts1)
	}

	advance(10 * time.Second)
	loginCD1 := makeClientDataJSON(t, "webauthn.get", reqOpts1.Challenge, ts.URL)
	loginAD1 := buildTestAssertionAuthData(reqOpts1.RPID, webAuthnFlagUP, 5)
	ecSig1 := signAssertionECDSA(t, ecKey, loginAD1, loginCD1)

	resp, raw = passkeyJSONRequest(t, loginClient1, "POST", ts.URL+"/api/auth/passkey/login/finish", ts.URL, map[string]any{
		"id":    ecCredB64,
		"rawId": ecCredB64,
		"type":  "public-key",
		"response": map[string]any{
			"clientDataJSON":    base64.RawURLEncoding.EncodeToString(loginCD1),
			"authenticatorData": base64.RawURLEncoding.EncodeToString(loginAD1),
			"signature":         base64.RawURLEncoding.EncodeToString(ecSig1),
		},
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("finish login ES256 = %d %s", resp.StatusCode, raw)
	}
	var loggedIn1 meResponse
	if err := json.Unmarshal(raw, &loggedIn1); err != nil {
		t.Fatal(err)
	}
	if loggedIn1.User.ID != regMe.User.ID || len(loggedIn1.Workspaces) != 1 {
		t.Fatalf("unexpected ES256 login meResponse: %+v", loggedIn1)
	}
	// Verify session cookie works!
	resp, _ = passkeyJSONRequest(t, loginClient1, "GET", ts.URL+"/api/me", "", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/me after ES256 passkey login = %d, want 200", resp.StatusCode)
	}

	// --- 4. Discoverable resident-key login with RS256 (NO email provided!) + repeated signCount=0 ---
	for round := 0; round < 2; round++ {
		loginJar2, _ := cookiejar.New(nil)
		loginClient2 := &http.Client{Jar: loginJar2}
		resp, raw = passkeyJSONRequest(t, loginClient2, "POST", ts.URL+"/api/auth/passkey/login/begin", ts.URL, map[string]any{})
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("round %d begin discoverable login = %d %s", round, resp.StatusCode, raw)
		}
		var reqOpts2 webAuthnRequestOptions
		if err := json.Unmarshal(raw, &reqOpts2); err != nil {
			t.Fatal(err)
		}
		if len(reqOpts2.AllowCredentials) != 0 {
			t.Fatalf("discoverable flow should not include allowCredentials, got %+v", reqOpts2.AllowCredentials)
		}
		loginCD2 := makeClientDataJSON(t, "webauthn.get", reqOpts2.Challenge, ts.URL)
		loginAD2 := buildTestAssertionAuthData(reqOpts2.RPID, webAuthnFlagUP, 0)
		rsaSig := signAssertionRSA(t, rsaKey, loginAD2, loginCD2)

		resp, raw = passkeyJSONRequest(t, loginClient2, "POST", ts.URL+"/api/auth/passkey/login/finish", ts.URL, map[string]any{
			"id":    rsaCredB64,
			"rawId": rsaCredB64,
			"type":  "public-key",
			"response": map[string]any{
				"clientDataJSON":    base64.RawURLEncoding.EncodeToString(loginCD2),
				"authenticatorData": base64.RawURLEncoding.EncodeToString(loginAD2),
				"signature":         base64.RawURLEncoding.EncodeToString(rsaSig),
			},
		})
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("round %d finish RS256 login = %d %s", round, resp.StatusCode, raw)
		}
		resp, _ = passkeyJSONRequest(t, loginClient2, "GET", ts.URL+"/api/me", "", nil)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("round %d GET /api/me after RS256 login = %d", round, resp.StatusCode)
		}
	}

	// Verify audit logs captured auth.passkey_registered (2) and auth.passkey_login (3).
	resp, raw = passkeyJSONRequest(t, client, "GET", ts.URL+"/api/workspaces/1/audit-logs?limit=50", "", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("audit-logs = %d %s", resp.StatusCode, raw)
	}
	var page store.AuditLogPage
	if err := json.Unmarshal(raw, &page); err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, it := range page.Items {
		counts[it.Action]++
	}
	if counts["auth.passkey_registered"] != 2 || counts["auth.passkey_login"] != 3 {
		t.Fatalf("unexpected passkey audit counts: %+v", counts)
	}
}

func TestPasskeysSecurityRejectionsAndMFAPolicyProtection(t *testing.T) {
	st := store.NewMemory()
	_, ts, nowPtr, clockMu := newPasskeyTestServer(t, st)
	advance := func(d time.Duration) {
		clockMu.Lock()
		*nowPtr = nowPtr.Add(d)
		clockMu.Unlock()
	}

	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}

	resp, raw := passkeyJSONRequest(t, client, "POST", ts.URL+"/api/auth/register", "", map[string]any{
		"email":    "sec-pk@example.com",
		"name":     "Sec User",
		"password": "super-secret-password",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register = %d %s", resp.StatusCode, raw)
	}
	var regMe meResponse
	_ = json.Unmarshal(raw, &regMe)

	ecKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	credID := []byte("sec-cred-01")
	credB64 := base64.RawURLEncoding.EncodeToString(credID)

	beginReg := func() webAuthnCreationOptions {
		t.Helper()
		r, b := passkeyJSONRequest(t, client, "POST", ts.URL+"/api/me/passkeys/register/begin", ts.URL, map[string]any{})
		if r.StatusCode != http.StatusOK {
			t.Fatalf("beginReg = %d %s", r.StatusCode, b)
		}
		var opts webAuthnCreationOptions
		if err := json.Unmarshal(b, &opts); err != nil {
			t.Fatal(err)
		}
		return opts
	}

	// 1. Register with wrong origin -> 400 invalid_origin.
	opts := beginReg()
	badOriginCD := makeClientDataJSON(t, "webauthn.create", opts.Challenge, "https://evil.example.com")
	attObj := buildTestAttestationObject(opts.RP.ID, webAuthnFlagUP|webAuthnFlagAT, 10, [16]byte{}, credID, encodeCOSEES256(&ecKey.PublicKey))
	resp, raw = passkeyJSONRequest(t, client, "POST", ts.URL+"/api/me/passkeys/register/finish", ts.URL, map[string]any{
		"name":  "Bad Origin Key",
		"rawId": credB64,
		"type":  "public-key",
		"response": map[string]any{
			"clientDataJSON":    base64.RawURLEncoding.EncodeToString(badOriginCD),
			"attestationObject": base64.RawURLEncoding.EncodeToString(attObj),
		},
	})
	if resp.StatusCode != http.StatusBadRequest || !strings.Contains(string(raw), "invalid_origin") {
		t.Fatalf("wrong origin reg = %d %s, want 400 invalid_origin", resp.StatusCode, raw)
	}

	// 2. Register with wrong RP ID hash -> 400 invalid_rp_id.
	opts = beginReg()
	goodCD := makeClientDataJSON(t, "webauthn.create", opts.Challenge, ts.URL)
	wrongRPAtt := buildTestAttestationObject("wrong.example.com", webAuthnFlagUP|webAuthnFlagAT, 10, [16]byte{}, credID, encodeCOSEES256(&ecKey.PublicKey))
	resp, raw = passkeyJSONRequest(t, client, "POST", ts.URL+"/api/me/passkeys/register/finish", ts.URL, map[string]any{
		"name":  "Wrong RP Key",
		"rawId": credB64,
		"type":  "public-key",
		"response": map[string]any{
			"clientDataJSON":    base64.RawURLEncoding.EncodeToString(goodCD),
			"attestationObject": base64.RawURLEncoding.EncodeToString(wrongRPAtt),
		},
	})
	if resp.StatusCode != http.StatusBadRequest || !strings.Contains(string(raw), "invalid_rp_id") {
		t.Fatalf("wrong RP ID reg = %d %s, want 400 invalid_rp_id", resp.StatusCode, raw)
	}

	// 3. Register with UP bit unset -> 400 user_not_present.
	opts = beginReg()
	goodCD = makeClientDataJSON(t, "webauthn.create", opts.Challenge, ts.URL)
	noUPAtt := buildTestAttestationObject(opts.RP.ID, webAuthnFlagAT, 10, [16]byte{}, credID, encodeCOSEES256(&ecKey.PublicKey))
	resp, raw = passkeyJSONRequest(t, client, "POST", ts.URL+"/api/me/passkeys/register/finish", ts.URL, map[string]any{
		"name":  "No UP Key",
		"rawId": credB64,
		"type":  "public-key",
		"response": map[string]any{
			"clientDataJSON":    base64.RawURLEncoding.EncodeToString(goodCD),
			"attestationObject": base64.RawURLEncoding.EncodeToString(noUPAtt),
		},
	})
	if resp.StatusCode != http.StatusBadRequest || !strings.Contains(string(raw), "user_not_present") {
		t.Fatalf("missing UP reg = %d %s, want 400 user_not_present", resp.StatusCode, raw)
	}

	// 4. Legitimate registration with signCount = 10 succeeds.
	opts = beginReg()
	goodCD = makeClientDataJSON(t, "webauthn.create", opts.Challenge, ts.URL)
	goodAtt := buildTestAttestationObject(opts.RP.ID, webAuthnFlagUP|webAuthnFlagAT, 10, [16]byte{}, credID, encodeCOSEES256(&ecKey.PublicKey))
	resp, raw = passkeyJSONRequest(t, client, "POST", ts.URL+"/api/me/passkeys/register/finish", ts.URL, map[string]any{
		"name":  "Primary Passkey",
		"rawId": credB64,
		"type":  "public-key",
		"response": map[string]any{
			"clientDataJSON":    base64.RawURLEncoding.EncodeToString(goodCD),
			"attestationObject": base64.RawURLEncoding.EncodeToString(goodAtt),
		},
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("valid reg = %d %s", resp.StatusCode, raw)
	}
	var pk1 passkeySummaryDTO
	_ = json.Unmarshal(raw, &pk1)

	beginLogin := func() webAuthnRequestOptions {
		t.Helper()
		r, b := passkeyJSONRequest(t, &http.Client{}, "POST", ts.URL+"/api/auth/passkey/login/begin", ts.URL, map[string]any{})
		if r.StatusCode != http.StatusOK {
			t.Fatalf("beginLogin = %d %s", r.StatusCode, b)
		}
		var o webAuthnRequestOptions
		if err := json.Unmarshal(b, &o); err != nil {
			t.Fatal(err)
		}
		return o
	}

	// 5. Login with tampered signature -> 401 invalid_signature.
	lOpts := beginLogin()
	lCD := makeClientDataJSON(t, "webauthn.get", lOpts.Challenge, ts.URL)
	lAD := buildTestAssertionAuthData(lOpts.RPID, webAuthnFlagUP, 11)
	sig := signAssertionECDSA(t, ecKey, lAD, lCD)
	sig[len(sig)-1] ^= 0xff // tamper signature byte
	resp, raw = passkeyJSONRequest(t, &http.Client{}, "POST", ts.URL+"/api/auth/passkey/login/finish", ts.URL, map[string]any{
		"rawId": credB64,
		"type":  "public-key",
		"response": map[string]any{
			"clientDataJSON":    base64.RawURLEncoding.EncodeToString(lCD),
			"authenticatorData": base64.RawURLEncoding.EncodeToString(lAD),
			"signature":         base64.RawURLEncoding.EncodeToString(sig),
		},
	})
	if resp.StatusCode != http.StatusUnauthorized || !strings.Contains(string(raw), "invalid_signature") {
		t.Fatalf("tampered sig = %d %s, want 401 invalid_signature", resp.StatusCode, raw)
	}

	// 6. Replayed challenge (even with valid signature!) -> 401 invalid_challenge.
	validSig := signAssertionECDSA(t, ecKey, lAD, lCD)
	resp, raw = passkeyJSONRequest(t, &http.Client{}, "POST", ts.URL+"/api/auth/passkey/login/finish", ts.URL, map[string]any{
		"rawId": credB64,
		"type":  "public-key",
		"response": map[string]any{
			"clientDataJSON":    base64.RawURLEncoding.EncodeToString(lCD),
			"authenticatorData": base64.RawURLEncoding.EncodeToString(lAD),
			"signature":         base64.RawURLEncoding.EncodeToString(validSig),
		},
	})
	if resp.StatusCode != http.StatusUnauthorized || !strings.Contains(string(raw), "invalid_challenge") {
		t.Fatalf("replayed challenge = %d %s, want 401 invalid_challenge", resp.StatusCode, raw)
	}

	// 7. Wrong origin during login -> 401 invalid_origin.
	lOpts = beginLogin()
	wrongOriginCD := makeClientDataJSON(t, "webauthn.get", lOpts.Challenge, "https://phish.example.com")
	lAD = buildTestAssertionAuthData(lOpts.RPID, webAuthnFlagUP, 11)
	validSig = signAssertionECDSA(t, ecKey, lAD, wrongOriginCD)
	resp, raw = passkeyJSONRequest(t, &http.Client{}, "POST", ts.URL+"/api/auth/passkey/login/finish", ts.URL, map[string]any{
		"rawId": credB64,
		"type":  "public-key",
		"response": map[string]any{
			"clientDataJSON":    base64.RawURLEncoding.EncodeToString(wrongOriginCD),
			"authenticatorData": base64.RawURLEncoding.EncodeToString(lAD),
			"signature":         base64.RawURLEncoding.EncodeToString(validSig),
		},
	})
	if resp.StatusCode != http.StatusUnauthorized || !strings.Contains(string(raw), "invalid_origin") {
		t.Fatalf("wrong origin login = %d %s, want 401 invalid_origin", resp.StatusCode, raw)
	}

	// 8. Wrong RP ID during login -> 401 invalid_rp_id.
	lOpts = beginLogin()
	lCD = makeClientDataJSON(t, "webauthn.get", lOpts.Challenge, ts.URL)
	wrongRPAD := buildTestAssertionAuthData("other.example.com", webAuthnFlagUP, 11)
	validSig = signAssertionECDSA(t, ecKey, wrongRPAD, lCD)
	resp, raw = passkeyJSONRequest(t, &http.Client{}, "POST", ts.URL+"/api/auth/passkey/login/finish", ts.URL, map[string]any{
		"rawId": credB64,
		"type":  "public-key",
		"response": map[string]any{
			"clientDataJSON":    base64.RawURLEncoding.EncodeToString(lCD),
			"authenticatorData": base64.RawURLEncoding.EncodeToString(wrongRPAD),
			"signature":         base64.RawURLEncoding.EncodeToString(validSig),
		},
	})
	if resp.StatusCode != http.StatusUnauthorized || !strings.Contains(string(raw), "invalid_rp_id") {
		t.Fatalf("wrong RP ID login = %d %s, want 401 invalid_rp_id", resp.StatusCode, raw)
	}

	// 9. Cloned authenticator signCount rollback (stored=10, reported=10 and reported=5) -> 401 sign_count_rollback!
	for _, rollbackCount := range []uint32{10, 5} {
		lOpts = beginLogin()
		lCD = makeClientDataJSON(t, "webauthn.get", lOpts.Challenge, ts.URL)
		rollAD := buildTestAssertionAuthData(lOpts.RPID, webAuthnFlagUP, rollbackCount)
		validSig = signAssertionECDSA(t, ecKey, rollAD, lCD)
		resp, raw = passkeyJSONRequest(t, &http.Client{}, "POST", ts.URL+"/api/auth/passkey/login/finish", ts.URL, map[string]any{
			"rawId": credB64,
			"type":  "public-key",
			"response": map[string]any{
				"clientDataJSON":    base64.RawURLEncoding.EncodeToString(lCD),
				"authenticatorData": base64.RawURLEncoding.EncodeToString(rollAD),
				"signature":         base64.RawURLEncoding.EncodeToString(validSig),
			},
		})
		if resp.StatusCode != http.StatusUnauthorized || !strings.Contains(string(raw), "sign_count_rollback") {
			t.Fatalf("rollback count=%d = %d %s, want 401 sign_count_rollback", rollbackCount, resp.StatusCode, raw)
		}
	}

	// 10. Expired login challenge -> 401 invalid_challenge.
	lOpts = beginLogin()
	advance(6 * time.Minute)
	lCD = makeClientDataJSON(t, "webauthn.get", lOpts.Challenge, ts.URL)
	lAD = buildTestAssertionAuthData(lOpts.RPID, webAuthnFlagUP, 11)
	validSig = signAssertionECDSA(t, ecKey, lAD, lCD)
	resp, raw = passkeyJSONRequest(t, &http.Client{}, "POST", ts.URL+"/api/auth/passkey/login/finish", ts.URL, map[string]any{
		"rawId": credB64,
		"type":  "public-key",
		"response": map[string]any{
			"clientDataJSON":    base64.RawURLEncoding.EncodeToString(lCD),
			"authenticatorData": base64.RawURLEncoding.EncodeToString(lAD),
			"signature":         base64.RawURLEncoding.EncodeToString(validSig),
		},
	})
	if resp.StatusCode != http.StatusUnauthorized || !strings.Contains(string(raw), "invalid_challenge") {
		t.Fatalf("expired challenge = %d %s, want 401 invalid_challenge", resp.StatusCode, raw)
	}

	// 11. Workspace-enforced MFA policy protection on deleting last passkey!
	resp, raw = passkeyJSONRequest(t, client, "PUT", ts.URL+"/api/workspaces/1/security-policy", "", map[string]any{
		"requireMfa": true,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("enable requireMfa = %d %s", resp.StatusCode, raw)
	}
	// GET /api/me/mfa shows mfaRequiredByPolicy=true, mfaSetupRequired=false (because passkey is registered!).
	resp, raw = passkeyJSONRequest(t, client, "GET", ts.URL+"/api/me/mfa", "", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("getMyMFA = %d %s", resp.StatusCode, raw)
	}
	var mfaStat mfaStatusResponse
	_ = json.Unmarshal(raw, &mfaStat)
	if !mfaStat.MFARequiredByPolicy || len(mfaStat.MFARequiredWorkspaces) != 1 || mfaStat.MFASetupRequired {
		t.Fatalf("expected policy required=true, setupRequired=false with passkey, got %+v", mfaStat)
	}

	// Attempting to delete the ONLY passkey while TOTP is off -> 409 mfa_required_by_policy!
	resp, raw = passkeyJSONRequest(t, client, "DELETE", ts.URL+"/api/me/passkeys/1", "", nil)
	if resp.StatusCode != http.StatusConflict || !strings.Contains(string(raw), "mfa_required_by_policy") {
		t.Fatalf("delete last passkey under MFA policy = %d %s, want 409 mfa_required_by_policy", resp.StatusCode, raw)
	}

	// Register a second passkey -> now deleting the first passkey succeeds (204)!
	ecKey2, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	cred2 := []byte("sec-cred-02")
	cred2B64 := base64.RawURLEncoding.EncodeToString(cred2)
	opts = beginReg()
	cd2 := makeClientDataJSON(t, "webauthn.create", opts.Challenge, ts.URL)
	att2 := buildTestAttestationObject(opts.RP.ID, webAuthnFlagUP|webAuthnFlagAT, 0, [16]byte{}, cred2, encodeCOSEES256(&ecKey2.PublicKey))
	resp, raw = passkeyJSONRequest(t, client, "POST", ts.URL+"/api/me/passkeys/register/finish", ts.URL, map[string]any{
		"name":  "Backup Passkey",
		"rawId": cred2B64,
		"type":  "public-key",
		"response": map[string]any{
			"clientDataJSON":    base64.RawURLEncoding.EncodeToString(cd2),
			"attestationObject": base64.RawURLEncoding.EncodeToString(att2),
		},
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register second passkey = %d %s", resp.StatusCode, raw)
	}

	resp, raw = passkeyJSONRequest(t, client, "DELETE", ts.URL+"/api/me/passkeys/1", "", nil)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete first passkey when backup exists = %d %s, want 204", resp.StatusCode, raw)
	}

	// Deleting the remaining passkey (id=2) is STILL blocked until policy is disabled!
	resp, raw = passkeyJSONRequest(t, client, "DELETE", ts.URL+"/api/me/passkeys/2", "", nil)
	if resp.StatusCode != http.StatusConflict || !strings.Contains(string(raw), "mfa_required_by_policy") {
		t.Fatalf("delete remaining last passkey = %d %s, want 409 mfa_required_by_policy", resp.StatusCode, raw)
	}

	// Turn off requireMfa -> deleting the remaining passkey succeeds (204).
	resp, raw = passkeyJSONRequest(t, client, "PUT", ts.URL+"/api/workspaces/1/security-policy", "", map[string]any{
		"requireMfa": false,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("disable requireMfa = %d %s", resp.StatusCode, raw)
	}
	resp, raw = passkeyJSONRequest(t, client, "DELETE", ts.URL+"/api/me/passkeys/2", "", nil)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete passkey after policy off = %d %s, want 204", resp.StatusCode, raw)
	}

	_ = pk1
}
