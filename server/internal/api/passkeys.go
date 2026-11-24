package api

import (
	"bytes"
	"crypto"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

const (
	webAuthnRPName       = "Jiange"
	webAuthnChallengeTTL = 5 * time.Minute
	webAuthnTimeoutMs    = 60000

	webAuthnFlagUP = 1 << 0 // User Present
	webAuthnFlagAT = 1 << 6 // Attested Credential Data included
	webAuthnFlagED = 1 << 7 // Extension Data included

	coseKtyEC2   = 2
	coseKtyRSA   = 3
	coseAlgES256 = -7
	coseAlgRS256 = -257
	coseCrvP256  = 1

	cborMaxDepth = 16
	cborMaxItems = 4096
	cborMaxBytes = 256 << 10 // 256 KiB
)

var (
	errInvalidCBOR        = errors.New("invalid CBOR encoding")
	errUnsupportedCOSEKey = errors.New("unsupported COSE public key")
	errInvalidAuthData    = errors.New("invalid WebAuthn authenticator data")
	errInvalidSignature   = errors.New("invalid WebAuthn assertion signature")
)

// --- Minimal RFC 8949 CBOR decoder (pure Go stdlib) ---

type cborMapEntry struct {
	key any
	val any
}

type cborMap []cborMapEntry

func cborIntValue(v any) (int64, bool) {
	switch n := v.(type) {
	case uint64:
		if n > math.MaxInt64 {
			return 0, false
		}
		return int64(n), true
	case int64:
		return n, true
	default:
		return 0, false
	}
}

func (m cborMap) getString(key string) (any, bool) {
	for _, e := range m {
		if ks, ok := e.key.(string); ok && ks == key {
			return e.val, true
		}
	}
	return nil, false
}

func (m cborMap) getInt(key int64) (any, bool) {
	for _, e := range m {
		if ki, ok := cborIntValue(e.key); ok && ki == key {
			return e.val, true
		}
	}
	return nil, false
}

type cborDecoder struct {
	data  []byte
	pos   int
	depth int
	items int
}

func decodeCBORPrefix(data []byte) (any, int, error) {
	if len(data) == 0 || len(data) > cborMaxBytes {
		return nil, 0, errInvalidCBOR
	}
	d := &cborDecoder{data: data}
	val, err := d.decodeItem()
	if err != nil {
		return nil, 0, err
	}
	return val, d.pos, nil
}

func decodeCBORFull(data []byte) (any, error) {
	val, consumed, err := decodeCBORPrefix(data)
	if err != nil {
		return nil, err
	}
	if consumed != len(data) {
		return nil, errInvalidCBOR
	}
	return val, nil
}

func (d *cborDecoder) readByte() (byte, error) {
	if d.pos >= len(d.data) {
		return 0, errInvalidCBOR
	}
	b := d.data[d.pos]
	d.pos++
	return b, nil
}

func (d *cborDecoder) readBytes(n uint64) ([]byte, error) {
	rem := uint64(len(d.data) - d.pos)
	if n > rem {
		return nil, errInvalidCBOR
	}
	out := make([]byte, int(n))
	copy(out, d.data[d.pos:d.pos+int(n)])
	d.pos += int(n)
	return out, nil
}

func (d *cborDecoder) readArg(ai byte) (uint64, error) {
	switch {
	case ai <= 23:
		return uint64(ai), nil
	case ai == 24:
		b, err := d.readByte()
		return uint64(b), err
	case ai == 25:
		if d.pos+2 > len(d.data) {
			return 0, errInvalidCBOR
		}
		v := uint64(binary.BigEndian.Uint16(d.data[d.pos : d.pos+2]))
		d.pos += 2
		return v, nil
	case ai == 26:
		if d.pos+4 > len(d.data) {
			return 0, errInvalidCBOR
		}
		v := uint64(binary.BigEndian.Uint32(d.data[d.pos : d.pos+4]))
		d.pos += 4
		return v, nil
	case ai == 27:
		if d.pos+8 > len(d.data) {
			return 0, errInvalidCBOR
		}
		v := binary.BigEndian.Uint64(d.data[d.pos : d.pos+8])
		d.pos += 8
		return v, nil
	default:
		return 0, errInvalidCBOR
	}
}

func (d *cborDecoder) decodeItem() (any, error) {
	d.items++
	if d.items > cborMaxItems || d.depth > cborMaxDepth {
		return nil, errInvalidCBOR
	}
	initial, err := d.readByte()
	if err != nil {
		return nil, err
	}
	major := initial >> 5
	ai := initial & 0x1f

	switch major {
	case 0: // unsigned integer
		return d.readArg(ai)

	case 1: // negative integer (-1 - arg)
		u, err := d.readArg(ai)
		if err != nil {
			return nil, err
		}
		if u > math.MaxInt64 {
			return nil, errInvalidCBOR
		}
		return -1 - int64(u), nil

	case 2: // byte string
		if ai == 31 {
			var buf bytes.Buffer
			d.depth++
			defer func() { d.depth-- }()
			for {
				if d.pos >= len(d.data) {
					return nil, errInvalidCBOR
				}
				if d.data[d.pos] == 0xff {
					d.pos++
					return buf.Bytes(), nil
				}
				chunkHeader, err := d.readByte()
				if err != nil || chunkHeader>>5 != 2 || chunkHeader&0x1f == 31 {
					return nil, errInvalidCBOR
				}
				n, err := d.readArg(chunkHeader & 0x1f)
				if err != nil {
					return nil, err
				}
				chunk, err := d.readBytes(n)
				if err != nil {
					return nil, err
				}
				buf.Write(chunk)
			}
		}
		n, err := d.readArg(ai)
		if err != nil {
			return nil, err
		}
		return d.readBytes(n)

	case 3: // text string
		if ai == 31 {
			var b strings.Builder
			d.depth++
			defer func() { d.depth-- }()
			for {
				if d.pos >= len(d.data) {
					return nil, errInvalidCBOR
				}
				if d.data[d.pos] == 0xff {
					d.pos++
					return b.String(), nil
				}
				chunkHeader, err := d.readByte()
				if err != nil || chunkHeader>>5 != 3 || chunkHeader&0x1f == 31 {
					return nil, errInvalidCBOR
				}
				n, err := d.readArg(chunkHeader & 0x1f)
				if err != nil {
					return nil, err
				}
				chunk, err := d.readBytes(n)
				if err != nil {
					return nil, err
				}
				b.Write(chunk)
			}
		}
		n, err := d.readArg(ai)
		if err != nil {
			return nil, err
		}
		raw, err := d.readBytes(n)
		if err != nil {
			return nil, err
		}
		return string(raw), nil

	case 4: // array
		d.depth++
		defer func() { d.depth-- }()
		if ai == 31 {
			out := make([]any, 0)
			for {
				if d.pos >= len(d.data) {
					return nil, errInvalidCBOR
				}
				if d.data[d.pos] == 0xff {
					d.pos++
					return out, nil
				}
				elem, err := d.decodeItem()
				if err != nil {
					return nil, err
				}
				out = append(out, elem)
			}
		}
		n, err := d.readArg(ai)
		if err != nil || n > uint64(cborMaxItems) {
			return nil, errInvalidCBOR
		}
		out := make([]any, 0, int(n))
		for i := uint64(0); i < n; i++ {
			elem, err := d.decodeItem()
			if err != nil {
				return nil, err
			}
			out = append(out, elem)
		}
		return out, nil

	case 5: // map
		d.depth++
		defer func() { d.depth-- }()
		if ai == 31 {
			out := make(cborMap, 0)
			for {
				if d.pos >= len(d.data) {
					return nil, errInvalidCBOR
				}
				if d.data[d.pos] == 0xff {
					d.pos++
					return out, nil
				}
				k, err := d.decodeItem()
				if err != nil {
					return nil, err
				}
				v, err := d.decodeItem()
				if err != nil {
					return nil, err
				}
				out = append(out, cborMapEntry{key: k, val: v})
			}
		}
		n, err := d.readArg(ai)
		if err != nil || n > uint64(cborMaxItems) {
			return nil, errInvalidCBOR
		}
		out := make(cborMap, 0, int(n))
		for i := uint64(0); i < n; i++ {
			k, err := d.decodeItem()
			if err != nil {
				return nil, err
			}
			v, err := d.decodeItem()
			if err != nil {
				return nil, err
			}
			out = append(out, cborMapEntry{key: k, val: v})
		}
		return out, nil

	case 6: // semantic tag (read tag number and decode tagged item)
		if _, err := d.readArg(ai); err != nil {
			return nil, err
		}
		d.depth++
		defer func() { d.depth-- }()
		return d.decodeItem()

	case 7: // simple values & IEEE 754 floats
		switch ai {
		case 20:
			return false, nil
		case 21:
			return true, nil
		case 22, 23:
			return nil, nil
		case 24:
			b, err := d.readByte()
			return uint64(b), err
		case 25: // float16
			raw, err := d.readBytes(2)
			if err != nil {
				return nil, err
			}
			return raw, nil
		case 26: // float32
			raw, err := d.readBytes(4)
			if err != nil {
				return nil, err
			}
			return math.Float32frombits(binary.BigEndian.Uint32(raw)), nil
		case 27: // float64
			raw, err := d.readBytes(8)
			if err != nil {
				return nil, err
			}
			return math.Float64frombits(binary.BigEndian.Uint64(raw)), nil
		default:
			if ai < 20 {
				return uint64(ai), nil
			}
			return nil, errInvalidCBOR
		}

	default:
		return nil, errInvalidCBOR
	}
}

// --- COSE Public Key Parsing & WebAuthn Verification ---

func parseCOSEPublicKey(coseBytes []byte) (crypto.PublicKey, error) {
	val, err := decodeCBORFull(coseBytes)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errUnsupportedCOSEKey, err)
	}
	m, ok := val.(cborMap)
	if !ok {
		return nil, errUnsupportedCOSEKey
	}
	rawKty, ok := m.getInt(1)
	if !ok {
		return nil, errUnsupportedCOSEKey
	}
	kty, ok := cborIntValue(rawKty)
	if !ok {
		return nil, errUnsupportedCOSEKey
	}
	rawAlg, ok := m.getInt(3)
	if !ok {
		return nil, errUnsupportedCOSEKey
	}
	alg, ok := cborIntValue(rawAlg)
	if !ok {
		return nil, errUnsupportedCOSEKey
	}

	switch {
	case kty == coseKtyEC2 && alg == coseAlgES256:
		rawCrv, ok := m.getInt(-1)
		if !ok {
			return nil, errUnsupportedCOSEKey
		}
		crv, ok := cborIntValue(rawCrv)
		if !ok || crv != coseCrvP256 {
			return nil, errUnsupportedCOSEKey
		}
		rawX, ok := m.getInt(-2)
		if !ok {
			return nil, errUnsupportedCOSEKey
		}
		rawY, ok := m.getInt(-3)
		if !ok {
			return nil, errUnsupportedCOSEKey
		}
		xBytes, okX := rawX.([]byte)
		yBytes, okY := rawY.([]byte)
		if !okX || !okY || len(xBytes) != 32 || len(yBytes) != 32 {
			return nil, errUnsupportedCOSEKey
		}
		// Validate that (x, y) is a valid non-infinity point on P-256 via crypto/ecdh.
		uncompressed := make([]byte, 65)
		uncompressed[0] = 0x04
		copy(uncompressed[1:33], xBytes)
		copy(uncompressed[33:65], yBytes)
		if _, err := ecdh.P256().NewPublicKey(uncompressed); err != nil {
			return nil, errUnsupportedCOSEKey
		}
		return &ecdsa.PublicKey{
			Curve: elliptic.P256(),
			X:     new(big.Int).SetBytes(xBytes),
			Y:     new(big.Int).SetBytes(yBytes),
		}, nil

	case kty == coseKtyRSA && alg == coseAlgRS256:
		rawN, ok := m.getInt(-1)
		if !ok {
			return nil, errUnsupportedCOSEKey
		}
		rawE, ok := m.getInt(-2)
		if !ok {
			return nil, errUnsupportedCOSEKey
		}
		nBytes, okN := rawN.([]byte)
		eBytes, okE := rawE.([]byte)
		if !okN || !okE || len(nBytes) == 0 || len(eBytes) == 0 || len(eBytes) > 8 {
			return nil, errUnsupportedCOSEKey
		}
		nInt := new(big.Int).SetBytes(nBytes)
		if nInt.BitLen() < 2048 || nInt.BitLen() > 8192 {
			return nil, errUnsupportedCOSEKey
		}
		eInt := new(big.Int).SetBytes(eBytes)
		if !eInt.IsInt64() {
			return nil, errUnsupportedCOSEKey
		}
		eVal := eInt.Int64()
		if eVal < 3 || eVal%2 == 0 || eVal > math.MaxInt32 {
			return nil, errUnsupportedCOSEKey
		}
		return &rsa.PublicKey{
			N: nInt,
			E: int(eVal),
		}, nil

	default:
		return nil, errUnsupportedCOSEKey
	}
}

func verifyWebAuthnSignature(coseBytes, authData, clientDataJSON, signature []byte) error {
	if len(signature) == 0 {
		return errInvalidSignature
	}
	pub, err := parseCOSEPublicKey(coseBytes)
	if err != nil {
		return err
	}
	clientHash := sha256.Sum256(clientDataJSON)
	h := sha256.New()
	h.Write(authData)
	h.Write(clientHash[:])
	digest := h.Sum(nil)

	switch k := pub.(type) {
	case *ecdsa.PublicKey:
		if !ecdsa.VerifyASN1(k, digest, signature) {
			return errInvalidSignature
		}
		return nil
	case *rsa.PublicKey:
		if err := rsa.VerifyPKCS1v15(k, crypto.SHA256, digest, signature); err != nil {
			return errInvalidSignature
		}
		return nil
	default:
		return errUnsupportedCOSEKey
	}
}

type parsedWebAuthnAuthData struct {
	RPIDHash      [32]byte
	Flags         byte
	SignCount     uint32
	AAGUID        string
	CredentialID  []byte
	PublicKeyCOSE []byte
}

func formatAAGUID(b []byte) string {
	if len(b) != 16 {
		return ""
	}
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func parseWebAuthnAuthData(raw []byte, requireAttested bool) (parsedWebAuthnAuthData, error) {
	if len(raw) < 37 {
		return parsedWebAuthnAuthData{}, errInvalidAuthData
	}
	var out parsedWebAuthnAuthData
	copy(out.RPIDHash[:], raw[0:32])
	out.Flags = raw[32]
	out.SignCount = binary.BigEndian.Uint32(raw[33:37])

	pos := 37
	hasAT := out.Flags&webAuthnFlagAT != 0
	hasED := out.Flags&webAuthnFlagED != 0

	if requireAttested && !hasAT {
		return parsedWebAuthnAuthData{}, errInvalidAuthData
	}
	if hasAT {
		if len(raw) < pos+18 {
			return parsedWebAuthnAuthData{}, errInvalidAuthData
		}
		out.AAGUID = formatAAGUID(raw[pos : pos+16])
		credLen := int(binary.BigEndian.Uint16(raw[pos+16 : pos+18]))
		pos += 18
		if credLen <= 0 || credLen > 1023 || len(raw) < pos+credLen {
			return parsedWebAuthnAuthData{}, errInvalidAuthData
		}
		out.CredentialID = append([]byte(nil), raw[pos:pos+credLen]...)
		pos += credLen

		_, coseConsumed, err := decodeCBORPrefix(raw[pos:])
		if err != nil || coseConsumed <= 0 {
			return parsedWebAuthnAuthData{}, errInvalidAuthData
		}
		out.PublicKeyCOSE = append([]byte(nil), raw[pos:pos+coseConsumed]...)
		pos += coseConsumed
	}
	if hasED {
		_, extConsumed, err := decodeCBORPrefix(raw[pos:])
		if err != nil || extConsumed <= 0 {
			return parsedWebAuthnAuthData{}, errInvalidAuthData
		}
		pos += extConsumed
	}
	if pos != len(raw) {
		return parsedWebAuthnAuthData{}, errInvalidAuthData
	}
	return out, nil
}

func parseAttestationObject(raw []byte) (fmtName string, authData []byte, err error) {
	val, err := decodeCBORFull(raw)
	if err != nil {
		return "", nil, err
	}
	m, ok := val.(cborMap)
	if !ok {
		return "", nil, errInvalidCBOR
	}
	rawFmt, ok := m.getString("fmt")
	if !ok {
		return "", nil, errInvalidCBOR
	}
	fmtStr, ok := rawFmt.(string)
	if !ok || strings.TrimSpace(fmtStr) == "" {
		return "", nil, errInvalidCBOR
	}
	rawAuthData, ok := m.getString("authData")
	if !ok {
		return "", nil, errInvalidCBOR
	}
	ad, ok := rawAuthData.([]byte)
	if !ok || len(ad) < 37 {
		return "", nil, errInvalidAuthData
	}
	return fmtStr, ad, nil
}

// --- Encoding, Origin & RP ID helpers ---

func decodeBase64URL(raw string) ([]byte, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, errors.New("empty base64url string")
	}
	trimmed = strings.TrimRight(trimmed, "=")
	return base64.RawURLEncoding.DecodeString(trimmed)
}

func randomBase64URL(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func encodeWebAuthnUserHandle(userID int64) string {
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], uint64(userID))
	return base64.RawURLEncoding.EncodeToString(buf[:])
}

func normalizeOriginHostPort(scheme, host string) string {
	host = strings.TrimSpace(host)
	h, port, err := net.SplitHostPort(host)
	if err != nil {
		return strings.ToLower(host)
	}
	h = strings.ToLower(h)
	if (scheme == "http" && port == "80") || (scheme == "https" && port == "443") {
		if strings.Contains(h, ":") {
			return "[" + h + "]"
		}
		return h
	}
	return net.JoinHostPort(h, port)
}

func extractHostname(host string) string {
	host = strings.TrimSpace(host)
	if h, _, err := net.SplitHostPort(host); err == nil && h != "" {
		return strings.ToLower(strings.Trim(h, "[]"))
	}
	return strings.ToLower(strings.Trim(host, "[]"))
}

func parseAndNormalizeOrigin(raw string) (origin, hostname string, ok bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", "", false
	}
	u, err := url.Parse(trimmed)
	if err != nil || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return "", "", false
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", "", false
	}
	hn := strings.ToLower(u.Hostname())
	if hn == "" {
		return "", "", false
	}
	return scheme + "://" + normalizeOriginHostPort(scheme, u.Host), hn, true
}

func webAuthnRPIDAndOrigin(r *http.Request) (rpID, origin string) {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if fwdProto := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0]); fwdProto != "" {
		lower := strings.ToLower(fwdProto)
		if lower == "http" || lower == "https" {
			scheme = lower
		}
	}
	reqHost := strings.TrimSpace(r.Host)
	if fwdHost := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Host"), ",")[0]); fwdHost != "" && !strings.ContainsAny(fwdHost, "/ \t\r\n") {
		reqHost = fwdHost
	}
	if reqHost == "" {
		reqHost = "localhost"
	}
	reqHostname := extractHostname(reqHost)
	canonicalOrigin := scheme + "://" + normalizeOriginHostPort(scheme, reqHost)

	if hdrOrigin, hdrHost, ok := parseAndNormalizeOrigin(r.Header.Get("Origin")); ok {
		if strings.EqualFold(hdrHost, reqHostname) {
			return hdrHost, hdrOrigin
		}
	}
	return reqHostname, canonicalOrigin
}

func decodeWebAuthnJSON(w http.ResponseWriter, r *http.Request, dst any, allowEmpty bool) bool {
	if r.Body == nil || r.ContentLength == 0 {
		if allowEmpty {
			return true
		}
		httpx.Error(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(dst); err != nil {
		if allowEmpty && errors.Is(err, io.EOF) {
			return true
		}
		httpx.Error(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
		return false
	}
	return true
}

// --- API DTOs ---

type passkeySummaryDTO struct {
	ID           int64      `json:"id"`
	Name         string     `json:"name"`
	CredentialID string     `json:"credentialId"`
	AAGUID       string     `json:"aaguid"`
	Transports   []string   `json:"transports"`
	CreatedAt    time.Time  `json:"createdAt"`
	LastUsedAt   *time.Time `json:"lastUsedAt"`
}

func toPasskeySummaryDTO(pk store.UserPasskey) passkeySummaryDTO {
	transports := pk.Transports
	if transports == nil {
		transports = []string{}
	}
	return passkeySummaryDTO{
		ID:           pk.ID,
		Name:         pk.Name,
		CredentialID: base64.RawURLEncoding.EncodeToString(pk.CredentialID),
		AAGUID:       pk.AAGUID,
		Transports:   transports,
		CreatedAt:    pk.CreatedAt,
		LastUsedAt:   pk.LastUsedAt,
	}
}

type webAuthnRP struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type webAuthnUserEntity struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
}

type webAuthnPubKeyCredParam struct {
	Type string `json:"type"`
	Alg  int    `json:"alg"`
}

type webAuthnCredentialDescriptor struct {
	Type       string   `json:"type"`
	ID         string   `json:"id"`
	Transports []string `json:"transports,omitempty"`
}

type webAuthnAuthenticatorSelection struct {
	ResidentKey        string `json:"residentKey"`
	RequireResidentKey bool   `json:"requireResidentKey"`
	UserVerification   string `json:"userVerification"`
}

type webAuthnCreationOptions struct {
	RP                     webAuthnRP                     `json:"rp"`
	User                   webAuthnUserEntity             `json:"user"`
	Challenge              string                         `json:"challenge"`
	PubKeyCredParams       []webAuthnPubKeyCredParam      `json:"pubKeyCredParams"`
	Timeout                int                            `json:"timeout"`
	ExcludeCredentials     []webAuthnCredentialDescriptor `json:"excludeCredentials"`
	AuthenticatorSelection webAuthnAuthenticatorSelection `json:"authenticatorSelection"`
	Attestation            string                         `json:"attestation"`
}

type webAuthnRequestOptions struct {
	Challenge        string                         `json:"challenge"`
	Timeout          int                            `json:"timeout"`
	RPID             string                         `json:"rpId"`
	AllowCredentials []webAuthnCredentialDescriptor `json:"allowCredentials,omitempty"`
	UserVerification string                         `json:"userVerification"`
}

type webAuthnClientData struct {
	Type        string `json:"type"`
	Challenge   string `json:"challenge"`
	Origin      string `json:"origin"`
	CrossOrigin bool   `json:"crossOrigin,omitempty"`
}

type finishPasskeyRegisterRequest struct {
	Name       string   `json:"name"`
	ID         string   `json:"id"`
	RawID      string   `json:"rawId"`
	Type       string   `json:"type"`
	Transports []string `json:"transports,omitempty"`
	Response   struct {
		ClientDataJSON    string   `json:"clientDataJSON"`
		AttestationObject string   `json:"attestationObject"`
		Transports        []string `json:"transports,omitempty"`
	} `json:"response"`
}

type beginPasskeyLoginRequest struct {
	Email string `json:"email,omitempty"`
}

type finishPasskeyLoginRequest struct {
	ID       string `json:"id"`
	RawID    string `json:"rawId"`
	Type     string `json:"type"`
	Response struct {
		ClientDataJSON    string `json:"clientDataJSON"`
		AuthenticatorData string `json:"authenticatorData"`
		Signature         string `json:"signature"`
		UserHandle        string `json:"userHandle,omitempty"`
	} `json:"response"`
}

func (s *Server) passkeyStore(w http.ResponseWriter) (store.PasskeyStore, bool) {
	st, ok := s.Store.(store.PasskeyStore)
	if !ok {
		httpx.Error(w, http.StatusNotImplemented, "not_implemented", "当前存储不支持通行密钥（Passkey）")
		return nil, false
	}
	return st, true
}

// --- HTTP Handlers ---

// listMyPasskeys handles GET /api/me/passkeys.
func (s *Server) listMyPasskeys(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "login required")
		return
	}
	pkStore, ok := s.passkeyStore(w)
	if !ok {
		return
	}
	items, err := pkStore.ListUserPasskeys(r.Context(), u.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	dtos := make([]passkeySummaryDTO, 0, len(items))
	for _, pk := range items {
		dtos = append(dtos, toPasskeySummaryDTO(pk))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"passkeys": dtos})
}

// deleteMyPasskey handles DELETE /api/me/passkeys/{pid}.
func (s *Server) deleteMyPasskey(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "login required")
		return
	}
	pkStore, ok := s.passkeyStore(w)
	if !ok {
		return
	}
	pid := pathID(r, "pid")
	if pid <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "通行密钥 ID 无效")
		return
	}

	existing, err := pkStore.ListUserPasskeys(r.Context(), u.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	var target *store.UserPasskey
	for i := range existing {
		if existing[i].ID == pid {
			target = &existing[i]
			break
		}
	}
	if target == nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "通行密钥不存在")
		return
	}

	requiredByPolicy, _, err := s.userMFAPolicyStatus(r.Context(), u.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if requiredByPolicy && len(existing) <= 1 {
		totpEnabled, totpErr := s.userTOTPEnabled(r.Context(), u.ID)
		if totpErr != nil {
			s.fail(w, r, totpErr)
			return
		}
		if !totpEnabled {
			httpx.Error(w, http.StatusConflict, "mfa_required_by_policy", "所在工作空间已强制要求开启二步验证，请先开启 TOTP 二步验证或绑定其他通行密钥后再移除")
			return
		}
	}

	if err := pkStore.DeleteUserPasskey(r.Context(), u.ID, pid); errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "通行密钥不存在")
		return
	} else if err != nil {
		s.fail(w, r, err)
		return
	}

	s.recordAuthAudit(r, s.firstWorkspaceID(r, u.ID), u.ID, u.Name, u.Email, "auth.passkey_deleted", map[string]any{
		"passkeyId": pid,
		"name":      target.Name,
	})
	w.WriteHeader(http.StatusNoContent)
}

// beginPasskeyRegister handles POST /api/me/passkeys/register/begin.
func (s *Server) beginPasskeyRegister(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "login required")
		return
	}
	pkStore, ok := s.passkeyStore(w)
	if !ok {
		return
	}
	existing, err := pkStore.ListUserPasskeys(r.Context(), u.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if len(existing) >= store.MaxPasskeysPerUser {
		httpx.Error(w, http.StatusConflict, "passkey_limit_reached", "通行密钥数量已达上限")
		return
	}

	challenge, err := randomBase64URL(32)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	rpID, origin := webAuthnRPIDAndOrigin(r)
	now := s.now().UTC()
	uid := u.ID
	if err := pkStore.CreateWebAuthnChallenge(r.Context(), store.WebAuthnChallenge{
		Challenge: challenge,
		UserID:    &uid,
		Purpose:   store.WebAuthnPurposeRegister,
		RPID:      rpID,
		Origin:    origin,
		ExpiresAt: now.Add(webAuthnChallengeTTL),
		CreatedAt: now,
	}); err != nil {
		s.fail(w, r, err)
		return
	}

	excludes := make([]webAuthnCredentialDescriptor, 0, len(existing))
	for _, pk := range existing {
		excludes = append(excludes, webAuthnCredentialDescriptor{
			Type:       "public-key",
			ID:         base64.RawURLEncoding.EncodeToString(pk.CredentialID),
			Transports: pk.Transports,
		})
	}
	displayName := strings.TrimSpace(u.Name)
	if displayName == "" {
		displayName = u.Email
	}

	httpx.JSON(w, http.StatusOK, webAuthnCreationOptions{
		RP: webAuthnRP{
			ID:   rpID,
			Name: webAuthnRPName,
		},
		User: webAuthnUserEntity{
			ID:          encodeWebAuthnUserHandle(u.ID),
			Name:        u.Email,
			DisplayName: displayName,
		},
		Challenge: challenge,
		PubKeyCredParams: []webAuthnPubKeyCredParam{
			{Type: "public-key", Alg: coseAlgES256},
			{Type: "public-key", Alg: coseAlgRS256},
		},
		Timeout:            webAuthnTimeoutMs,
		ExcludeCredentials: excludes,
		AuthenticatorSelection: webAuthnAuthenticatorSelection{
			ResidentKey:        "preferred",
			RequireResidentKey: false,
			UserVerification:   "preferred",
		},
		Attestation: "none",
	})
}

// finishPasskeyRegister handles POST /api/me/passkeys/register/finish.
func (s *Server) finishPasskeyRegister(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "login required")
		return
	}
	pkStore, ok := s.passkeyStore(w)
	if !ok {
		return
	}

	var req finishPasskeyRegisterRequest
	if !decodeWebAuthnJSON(w, r, &req, false) {
		return
	}
	if req.Type != "" && req.Type != "public-key" {
		httpx.Error(w, http.StatusBadRequest, "invalid_credential_type", "不支持的凭证类型")
		return
	}
	clientDataBytes, err := decodeBase64URL(req.Response.ClientDataJSON)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_client_data", "clientDataJSON 编码无效")
		return
	}
	attestationBytes, err := decodeBase64URL(req.Response.AttestationObject)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_attestation", "attestationObject 编码无效")
		return
	}

	var clientData webAuthnClientData
	if err := json.Unmarshal(clientDataBytes, &clientData); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_client_data", "clientDataJSON 格式无效")
		return
	}
	if clientData.Type != "webauthn.create" {
		httpx.Error(w, http.StatusBadRequest, "invalid_client_data_type", "clientDataJSON 类型必须为 webauthn.create")
		return
	}
	if clientData.CrossOrigin {
		httpx.Error(w, http.StatusBadRequest, "invalid_origin", "不支持跨源注册通行密钥")
		return
	}

	now := s.now().UTC()
	ch, err := pkStore.ConsumeWebAuthnChallenge(r.Context(), clientData.Challenge, store.WebAuthnPurposeRegister, now)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusBadRequest, "invalid_challenge", "注册挑战已过期或无效，请重新发起绑定")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if ch.UserID == nil || *ch.UserID != u.ID || subtle.ConstantTimeCompare([]byte(clientData.Challenge), []byte(ch.Challenge)) != 1 {
		httpx.Error(w, http.StatusBadRequest, "invalid_challenge", "注册挑战校验失败")
		return
	}

	clientOrigin, _, originOK := parseAndNormalizeOrigin(clientData.Origin)
	if !originOK || clientOrigin != ch.Origin {
		httpx.Error(w, http.StatusBadRequest, "invalid_origin", "请求来源不匹配")
		return
	}
	if hdr := strings.TrimSpace(r.Header.Get("Origin")); hdr != "" {
		hdrNorm, _, hdrOK := parseAndNormalizeOrigin(hdr)
		if !hdrOK || hdrNorm != ch.Origin {
			httpx.Error(w, http.StatusBadRequest, "invalid_origin", "请求头来源不匹配")
			return
		}
	}

	_, authDataRaw, err := parseAttestationObject(attestationBytes)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_attestation", "attestationObject 解析失败")
		return
	}
	parsedAD, err := parseWebAuthnAuthData(authDataRaw, true)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_auth_data", "authenticatorData 解析失败")
		return
	}
	expectedRPIDHash := sha256.Sum256([]byte(ch.RPID))
	if subtle.ConstantTimeCompare(parsedAD.RPIDHash[:], expectedRPIDHash[:]) != 1 {
		httpx.Error(w, http.StatusBadRequest, "invalid_rp_id", "域名标识（RP ID）不匹配")
		return
	}
	if parsedAD.Flags&webAuthnFlagUP == 0 {
		httpx.Error(w, http.StatusBadRequest, "user_not_present", "未检测到用户存在确认（UP）")
		return
	}

	// If the caller supplied id or rawId, ensure it matches the attested credential ID.
	if rawIDStr := strings.TrimSpace(req.RawID); rawIDStr != "" {
		if rawID, err := decodeBase64URL(rawIDStr); err != nil || !bytes.Equal(rawID, parsedAD.CredentialID) {
			httpx.Error(w, http.StatusBadRequest, "credential_id_mismatch", "凭证 ID 与认证数据不匹配")
			return
		}
	} else if idStr := strings.TrimSpace(req.ID); idStr != "" {
		if rawID, err := decodeBase64URL(idStr); err != nil || !bytes.Equal(rawID, parsedAD.CredentialID) {
			httpx.Error(w, http.StatusBadRequest, "credential_id_mismatch", "凭证 ID 与认证数据不匹配")
			return
		}
	}

	if _, err := parseCOSEPublicKey(parsedAD.PublicKeyCOSE); err != nil {
		httpx.Error(w, http.StatusBadRequest, "unsupported_key_algorithm", "不支持的通行密钥算法，仅支持 ES256 (P-256) 和 RS256")
		return
	}

	transports := req.Response.Transports
	if len(transports) == 0 {
		transports = req.Transports
	}

	saved, err := pkStore.CreateUserPasskey(r.Context(), store.UserPasskey{
		UserID:        u.ID,
		CredentialID:  parsedAD.CredentialID,
		PublicKeyCOSE: parsedAD.PublicKeyCOSE,
		SignCount:     int64(parsedAD.SignCount),
		AAGUID:        parsedAD.AAGUID,
		Transports:    transports,
		Name:          req.Name,
		CreatedAt:     now,
	})
	if errors.Is(err, store.ErrConflict) {
		httpx.Error(w, http.StatusConflict, "passkey_conflict", "该通行密钥已绑定或已达数量上限")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}

	s.recordAuthAudit(r, s.firstWorkspaceID(r, u.ID), u.ID, u.Name, u.Email, "auth.passkey_registered", map[string]any{
		"passkeyId": saved.ID,
		"name":      saved.Name,
		"aaguid":    saved.AAGUID,
	})
	httpx.JSON(w, http.StatusCreated, toPasskeySummaryDTO(saved))
}

// beginPasskeyLogin handles POST /api/auth/passkey/login/begin (public route).
func (s *Server) beginPasskeyLogin(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	pkStore, ok := s.passkeyStore(w)
	if !ok {
		return
	}

	var req beginPasskeyLoginRequest
	if !decodeWebAuthnJSON(w, r, &req, true) {
		return
	}

	var (
		targetUserID     *int64
		allowCredentials []webAuthnCredentialDescriptor
	)
	email := strings.TrimSpace(req.Email)
	if email != "" {
		u, err := s.Store.UserByEmail(r.Context(), email)
		if err == nil {
			pks, pkErr := pkStore.ListUserPasskeys(r.Context(), u.ID)
			if pkErr != nil {
				s.fail(w, r, pkErr)
				return
			}
			if len(pks) > 0 {
				uid := u.ID
				targetUserID = &uid
				allowCredentials = make([]webAuthnCredentialDescriptor, 0, len(pks))
				for _, pk := range pks {
					allowCredentials = append(allowCredentials, webAuthnCredentialDescriptor{
						Type:       "public-key",
						ID:         base64.RawURLEncoding.EncodeToString(pk.CredentialID),
						Transports: pk.Transports,
					})
				}
			}
		} else if !errors.Is(err, store.ErrNotFound) {
			s.fail(w, r, err)
			return
		}
	}

	challenge, err := randomBase64URL(32)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	rpID, origin := webAuthnRPIDAndOrigin(r)
	now := s.now().UTC()
	if err := pkStore.CreateWebAuthnChallenge(r.Context(), store.WebAuthnChallenge{
		Challenge: challenge,
		UserID:    targetUserID,
		Purpose:   store.WebAuthnPurposeLogin,
		RPID:      rpID,
		Origin:    origin,
		ExpiresAt: now.Add(webAuthnChallengeTTL),
		CreatedAt: now,
	}); err != nil {
		s.fail(w, r, err)
		return
	}

	httpx.JSON(w, http.StatusOK, webAuthnRequestOptions{
		Challenge:        challenge,
		Timeout:          webAuthnTimeoutMs,
		RPID:             rpID,
		AllowCredentials: allowCredentials,
		UserVerification: "preferred",
	})
}

// finishPasskeyLogin handles POST /api/auth/passkey/login/finish (public route).
func (s *Server) finishPasskeyLogin(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	pkStore, ok := s.passkeyStore(w)
	if !ok {
		return
	}

	var req finishPasskeyLoginRequest
	if !decodeWebAuthnJSON(w, r, &req, false) {
		return
	}
	if req.Type != "" && req.Type != "public-key" {
		httpx.Error(w, http.StatusBadRequest, "invalid_credential_type", "不支持的凭证类型")
		return
	}
	credIDRaw := strings.TrimSpace(req.RawID)
	if credIDRaw == "" {
		credIDRaw = strings.TrimSpace(req.ID)
	}
	credID, err := decodeBase64URL(credIDRaw)
	if err != nil || len(credID) == 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_credential_id", "凭证 ID 无效")
		return
	}
	clientDataBytes, err := decodeBase64URL(req.Response.ClientDataJSON)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_client_data", "clientDataJSON 编码无效")
		return
	}
	authDataRaw, err := decodeBase64URL(req.Response.AuthenticatorData)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_auth_data", "authenticatorData 编码无效")
		return
	}
	signature, err := decodeBase64URL(req.Response.Signature)
	if err != nil || len(signature) == 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_signature", "signature 编码无效")
		return
	}

	var clientData webAuthnClientData
	if err := json.Unmarshal(clientDataBytes, &clientData); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_client_data", "clientDataJSON 格式无效")
		return
	}
	if clientData.Type != "webauthn.get" {
		httpx.Error(w, http.StatusBadRequest, "invalid_client_data_type", "clientDataJSON 类型必须为 webauthn.get")
		return
	}
	if clientData.CrossOrigin {
		httpx.Error(w, http.StatusUnauthorized, "invalid_origin", "不支持跨源通行密钥登录")
		return
	}

	now := s.now().UTC()
	ch, err := pkStore.ConsumeWebAuthnChallenge(r.Context(), clientData.Challenge, store.WebAuthnPurposeLogin, now)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusUnauthorized, "invalid_challenge", "通行密钥登录会话已过期或无效，请重试")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if subtle.ConstantTimeCompare([]byte(clientData.Challenge), []byte(ch.Challenge)) != 1 {
		httpx.Error(w, http.StatusUnauthorized, "invalid_challenge", "登录挑战校验失败")
		return
	}

	clientOrigin, _, originOK := parseAndNormalizeOrigin(clientData.Origin)
	if !originOK || clientOrigin != ch.Origin {
		httpx.Error(w, http.StatusUnauthorized, "invalid_origin", "请求来源不匹配")
		return
	}
	if hdr := strings.TrimSpace(r.Header.Get("Origin")); hdr != "" {
		hdrNorm, _, hdrOK := parseAndNormalizeOrigin(hdr)
		if !hdrOK || hdrNorm != ch.Origin {
			httpx.Error(w, http.StatusUnauthorized, "invalid_origin", "请求头来源不匹配")
			return
		}
	}

	parsedAD, err := parseWebAuthnAuthData(authDataRaw, false)
	if err != nil {
		httpx.Error(w, http.StatusUnauthorized, "invalid_auth_data", "authenticatorData 无效")
		return
	}
	expectedRPIDHash := sha256.Sum256([]byte(ch.RPID))
	if subtle.ConstantTimeCompare(parsedAD.RPIDHash[:], expectedRPIDHash[:]) != 1 {
		httpx.Error(w, http.StatusUnauthorized, "invalid_rp_id", "域名标识（RP ID）不匹配")
		return
	}
	if parsedAD.Flags&webAuthnFlagUP == 0 {
		httpx.Error(w, http.StatusUnauthorized, "user_not_present", "未检测到用户存在确认（UP）")
		return
	}

	pk, err := pkStore.GetUserPasskeyByCredentialID(r.Context(), credID)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusUnauthorized, "passkey_not_found", "未找到匹配的通行密钥")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if ch.UserID != nil && pk.UserID != *ch.UserID {
		httpx.Error(w, http.StatusUnauthorized, "passkey_user_mismatch", "通行密钥与当前账号不匹配")
		return
	}

	if err := verifyWebAuthnSignature(pk.PublicKeyCOSE, authDataRaw, clientDataBytes, signature); err != nil {
		httpx.Error(w, http.StatusUnauthorized, "invalid_signature", "通行密钥签名校验失败")
		return
	}

	// WebAuthn Level 2 §7.2 clone detection: when either stored or reported signCount > 0,
	// the new signCount must strictly exceed the previously recorded signCount.
	newSignCount := int64(parsedAD.SignCount)
	if (newSignCount > 0 || pk.SignCount > 0) && newSignCount <= pk.SignCount {
		httpx.Error(w, http.StatusUnauthorized, "sign_count_rollback", "检测到通行密钥签名计数异常，可能存在克隆风险")
		return
	}

	nextCount := pk.SignCount
	if newSignCount > nextCount {
		nextCount = newSignCount
	}
	if err := pkStore.UpdateUserPasskeySignCount(r.Context(), pk.ID, nextCount, now); err != nil {
		s.fail(w, r, err)
		return
	}

	mfaStore, ok := s.mfaStore()
	if !ok {
		httpx.Error(w, http.StatusNotImplemented, "not_implemented", "当前存储不支持按 ID 查询用户")
		return
	}
	u, err := mfaStore.GetUserByIDForMFA(r.Context(), pk.UserID)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "账号不存在")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	ws, err := s.Store.Workspaces(r.Context(), u.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if !s.startSession(w, r, u.ID) {
		return
	}

	var auditWS int64
	if len(ws) > 0 {
		auditWS = ws[0].ID
	}
	s.recordAuthAudit(r, auditWS, u.ID, u.Name, u.Email, "auth.passkey_login", map[string]any{
		"passkeyId": pk.ID,
		"name":      pk.Name,
	})
	httpx.JSON(w, http.StatusOK, meResponse{u, ws})
}
