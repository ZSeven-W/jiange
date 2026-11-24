package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

const (
	// TOTPPeriodSeconds is the standard RFC 6238 time step (30 seconds).
	TOTPPeriodSeconds = 30
	// TOTPDigits is the standard 6-digit authenticator code length.
	TOTPDigits = 6
	// DefaultRecoveryCodeCount is the number of one-time recovery codes generated on MFA enrollment.
	DefaultRecoveryCodeCount = 8
)

var (
	// ErrInvalidTOTPSecret indicates a malformed or empty Base32 TOTP secret.
	ErrInvalidTOTPSecret = errors.New("auth: invalid totp secret")

	totpBase32 = base32.StdEncoding.WithPadding(base32.NoPadding)

	// Unambiguous 32-character alphabet (no 0/O/1/I) for readable recovery codes (5 bits/char).
	recoveryAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
)

// GenerateTOTPSecret generates a 160-bit (20-byte) random TOTP secret encoded as
// uppercase unpadded Base32 per RFC 4648 / Google Authenticator Key Uri Format.
func GenerateTOTPSecret() (string, error) {
	b := make([]byte, 20)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return totpBase32.EncodeToString(b), nil
}

func decodeTOTPSecret(secret string) ([]byte, error) {
	cleaned := strings.ToUpper(strings.TrimSpace(secret))
	cleaned = strings.ReplaceAll(cleaned, " ", "")
	cleaned = strings.ReplaceAll(cleaned, "-", "")
	cleaned = strings.TrimRight(cleaned, "=")
	if cleaned == "" {
		return nil, ErrInvalidTOTPSecret
	}
	key, err := totpBase32.DecodeString(cleaned)
	if err != nil || len(key) == 0 {
		return nil, ErrInvalidTOTPSecret
	}
	return key, nil
}

// TOTPCode computes the 6-digit RFC 6238 TOTP code using HMAC-SHA1 with a 30s period.
func TOTPCode(secret string, at time.Time) (string, error) {
	key, err := decodeTOTPSecret(secret)
	if err != nil {
		return "", err
	}
	unixSec := at.Unix()
	var counter uint64
	if unixSec >= 0 {
		counter = uint64(unixSec / TOTPPeriodSeconds)
	} else {
		// Floor division for pre-epoch timestamps, though standard TOTP uses unix >= 0.
		counter = uint64((unixSec - (TOTPPeriodSeconds - 1)) / TOTPPeriodSeconds)
	}
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], counter)

	mac := hmac.New(sha1.New, key)
	mac.Write(msg[:])
	sum := mac.Sum(nil)

	offset := sum[len(sum)-1] & 0x0f
	truncated := (uint32(sum[offset]&0x7f) << 24) |
		(uint32(sum[offset+1]) << 16) |
		(uint32(sum[offset+2]) << 8) |
		uint32(sum[offset+3])

	otp := truncated % 1_000_000
	return fmt.Sprintf("%06d", otp), nil
}

func normalizeTOTPCode(code string) (string, bool) {
	var b strings.Builder
	b.Grow(TOTPDigits)
	for i := 0; i < len(code); i++ {
		c := code[i]
		if c == ' ' || c == '-' || c == '\t' || c == '\r' || c == '\n' {
			continue
		}
		if c < '0' || c > '9' {
			return "", false
		}
		b.WriteByte(c)
	}
	out := b.String()
	if len(out) != TOTPDigits {
		return "", false
	}
	return out, true
}

// VerifyTOTP checks a 6-digit TOTP code against the secret across the
// previous, current, and next 30-second windows using constant-time comparison.
func VerifyTOTP(secret, code string, now time.Time) bool {
	normalized, ok := normalizeTOTPCode(code)
	if !ok {
		return false
	}
	if _, err := decodeTOTPSecret(secret); err != nil {
		return false
	}
	step := time.Duration(TOTPPeriodSeconds) * time.Second
	windows := [3]time.Time{
		now.Add(-step),
		now,
		now.Add(step),
	}
	matched := 0
	codeBytes := []byte(normalized)
	for _, ts := range windows {
		expected, err := TOTPCode(secret, ts)
		if err != nil {
			continue
		}
		if subtle.ConstantTimeCompare([]byte(expected), codeBytes) == 1 {
			matched = 1
		}
	}
	return matched == 1
}

// BuildOtpAuthURI builds a standard otpauth://totp URI compatible with
// Google Authenticator, 1Password, Authy, and Feishu Authenticator.
func BuildOtpAuthURI(issuer, account, secret string) string {
	cleanIssuer := strings.TrimSpace(issuer)
	if cleanIssuer == "" {
		cleanIssuer = "Jiange"
	}
	cleanAccount := strings.TrimSpace(account)
	cleanSecret := strings.ToUpper(strings.TrimSpace(secret))
	cleanSecret = strings.ReplaceAll(cleanSecret, " ", "")
	cleanSecret = strings.ReplaceAll(cleanSecret, "-", "")
	cleanSecret = strings.TrimRight(cleanSecret, "=")

	label := url.PathEscape(cleanIssuer) + ":" + url.PathEscape(cleanAccount)
	return fmt.Sprintf(
		"otpauth://totp/%s?secret=%s&issuer=%s&algorithm=SHA1&digits=%d&period=%d",
		label,
		url.QueryEscape(cleanSecret),
		url.QueryEscape(cleanIssuer),
		TOTPDigits,
		TOTPPeriodSeconds,
	)
}

func normalizeRecoveryCode(code string) string {
	var b strings.Builder
	b.Grow(len(code))
	for i := 0; i < len(code); i++ {
		c := code[i]
		if c == ' ' || c == '-' || c == '\t' || c == '\r' || c == '\n' {
			continue
		}
		if c >= 'a' && c <= 'z' {
			c = c - 'a' + 'A'
		}
		b.WriteByte(c)
	}
	return b.String()
}

func hashRecoveryCode(normalized string) string {
	sum := sha256.Sum256([]byte(normalized))
	return hex.EncodeToString(sum[:])
}

// GenerateRecoveryCodes generates n readable one-time recovery codes (XXXX-XXXX)
// along with their lowercase hex SHA-256 digests.
func GenerateRecoveryCodes(n int) (plain []string, hashes []string, err error) {
	if n <= 0 {
		return []string{}, []string{}, nil
	}
	plain = make([]string, 0, n)
	hashes = make([]string, 0, n)
	seen := make(map[string]struct{}, n)

	var buf [8]byte
	for len(plain) < n {
		if _, err := rand.Read(buf[:]); err != nil {
			return nil, nil, err
		}
		var chars [8]byte
		for i := 0; i < 8; i++ {
			chars[i] = recoveryAlphabet[buf[i]&0x1f]
		}
		formatted := string(chars[:4]) + "-" + string(chars[4:])
		if _, dup := seen[formatted]; dup {
			continue
		}
		seen[formatted] = struct{}{}
		plain = append(plain, formatted)
		hashes = append(hashes, hashRecoveryCode(normalizeRecoveryCode(formatted)))
	}
	return plain, hashes, nil
}

// MatchRecoveryCode compares input against stored lowercase hex SHA-256 recovery code
// hashes in constant time, returning the matched index or -1 when unmatched.
func MatchRecoveryCode(input string, hashes []string) int {
	normalized := normalizeRecoveryCode(input)
	if normalized == "" || len(hashes) == 0 {
		return -1
	}
	got := []byte(hashRecoveryCode(normalized))
	matchedIdx := -1
	for i, h := range hashes {
		target := []byte(strings.ToLower(strings.TrimSpace(h)))
		if len(target) == len(got) && subtle.ConstantTimeCompare(got, target) == 1 && matchedIdx == -1 {
			matchedIdx = i
		}
	}
	return matchedIdx
}
