package auth

import (
	"encoding/base32"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestTOTPGenerateSecret(t *testing.T) {
	s1, err := GenerateTOTPSecret()
	if err != nil {
		t.Fatalf("GenerateTOTPSecret failed: %v", err)
	}
	s2, err := GenerateTOTPSecret()
	if err != nil {
		t.Fatalf("GenerateTOTPSecret second call failed: %v", err)
	}
	if s1 == s2 {
		t.Fatalf("expected unique random secrets, got identical %q", s1)
	}
	// 20 bytes in unpadded Base32 = 32 uppercase characters without '='.
	if len(s1) != 32 {
		t.Fatalf("expected 32-char Base32 secret, got len=%d (%q)", len(s1), s1)
	}
	if strings.Contains(s1, "=") {
		t.Fatalf("expected unpadded Base32 secret, got %q", s1)
	}
	if s1 != strings.ToUpper(s1) {
		t.Fatalf("expected uppercase Base32 secret, got %q", s1)
	}
	raw, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(s1)
	if err != nil {
		t.Fatalf("secret is not valid unpadded Base32: %v", err)
	}
	if len(raw) != 20 {
		t.Fatalf("expected 20 decoded bytes, got %d", len(raw))
	}
}

// TestTOTPRFC6238Vectors verifies TOTPCode against every SHA-1 test vector in RFC 6238 Appendix B
// (last 6 digits of the RFC 8-digit reference table).
func TestTOTPRFC6238Vectors(t *testing.T) {
	// RFC 6238 SHA-1 test seed: ASCII "12345678901234567890" (20 bytes)
	secret := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString([]byte("12345678901234567890"))
	if secret != "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" {
		t.Fatalf("unexpected encoded RFC test seed: %q", secret)
	}

	vectors := []struct {
		unix int64
		want string
	}{
		{59, "287082"},
		{1111111109, "081804"},
		{1111111111, "050471"},
		{1234567890, "005924"},
		{2000000000, "279037"},
		{20000000000, "353130"},
	}

	for _, tc := range vectors {
		got, err := TOTPCode(secret, time.Unix(tc.unix, 0).UTC())
		if err != nil {
			t.Fatalf("TOTPCode(unix=%d) returned error: %v", tc.unix, err)
		}
		if got != tc.want {
			t.Errorf("TOTPCode(unix=%d) = %q, want %q", tc.unix, got, tc.want)
		}
	}
}

func TestTOTPCodeInvalidSecret(t *testing.T) {
	for _, bad := range []string{"", "   ", "not-valid-base32!!!", "===="} {
		if _, err := TOTPCode(bad, time.Unix(1234567890, 0)); err == nil {
			t.Errorf("expected error for invalid secret %q", bad)
		}
	}
}

func TestTOTPVerifyWindowAndFormatting(t *testing.T) {
	secret := "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
	baseTime := time.Unix(1234567890, 0).UTC()

	prevCode, err := TOTPCode(secret, baseTime.Add(-30*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	currCode, err := TOTPCode(secret, baseTime)
	if err != nil {
		t.Fatal(err)
	}
	nextCode, err := TOTPCode(secret, baseTime.Add(30*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	tooOldCode, err := TOTPCode(secret, baseTime.Add(-60*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	tooNewCode, err := TOTPCode(secret, baseTime.Add(60*time.Second))
	if err != nil {
		t.Fatal(err)
	}

	// Exact, -30s, +30s windows should all pass.
	if !VerifyTOTP(secret, currCode, baseTime) {
		t.Fatalf("expected current window code %s to verify", currCode)
	}
	if !VerifyTOTP(secret, prevCode, baseTime) {
		t.Fatalf("expected -30s window code %s to verify", prevCode)
	}
	if !VerifyTOTP(secret, nextCode, baseTime) {
		t.Fatalf("expected +30s window code %s to verify", nextCode)
	}

	// Spaces and dashes should be stripped cleanly.
	formatted := currCode[:3] + " " + currCode[3:]
	if !VerifyTOTP(secret, formatted, baseTime) {
		t.Fatalf("expected space-separated code %q to verify", formatted)
	}
	dashed := currCode[:3] + "-" + currCode[3:]
	if !VerifyTOTP(secret, dashed, baseTime) {
		t.Fatalf("expected dash-separated code %q to verify", dashed)
	}

	// +/- 60s codes should fail (unless astronomically identical by chance).
	if tooOldCode != prevCode && tooOldCode != currCode && tooOldCode != nextCode {
		if VerifyTOTP(secret, tooOldCode, baseTime) {
			t.Fatalf("expected -60s code %s to fail verification", tooOldCode)
		}
	}
	if tooNewCode != prevCode && tooNewCode != currCode && tooNewCode != nextCode {
		if VerifyTOTP(secret, tooNewCode, baseTime) {
			t.Fatalf("expected +60s code %s to fail verification", tooNewCode)
		}
	}

	// Malformed codes and invalid secrets must fail.
	for _, bad := range []string{"", "12345", "1234567", "abcdef", "12a456"} {
		if VerifyTOTP(secret, bad, baseTime) {
			t.Errorf("expected malformed code %q to fail", bad)
		}
	}
	if VerifyTOTP("!!!invalid!!!", currCode, baseTime) {
		t.Fatalf("expected invalid secret to fail verification")
	}
}

func TestTOTPBuildOtpAuthURI(t *testing.T) {
	uri := BuildOtpAuthURI("Jiange", "alice@example.com", "JBSWY3DPEHPK3PXP")
	want := "otpauth://totp/Jiange:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Jiange&algorithm=SHA1&digits=6&period=30"
	if uri != want {
		t.Fatalf("BuildOtpAuthURI =\n  %q\nwant:\n  %q", uri, want)
	}

	// Empty issuer defaults to Jiange and lower/padded secret is normalized.
	uri2 := BuildOtpAuthURI("", "bob+1@corp.io", "jbswy3dp== ")
	if !strings.HasPrefix(uri2, "otpauth://totp/Jiange:bob+1@corp.io?secret=JBSWY3DP&issuer=Jiange&algorithm=SHA1&digits=6&period=30") {
		t.Fatalf("unexpected normalized URI: %q", uri2)
	}
}

func TestTOTPRecoveryCodes(t *testing.T) {
	plain, hashes, err := GenerateRecoveryCodes(8)
	if err != nil {
		t.Fatalf("GenerateRecoveryCodes failed: %v", err)
	}
	if len(plain) != 8 || len(hashes) != 8 {
		t.Fatalf("expected 8 plain & 8 hashes, got %d & %d", len(plain), len(hashes))
	}

	codePattern := regexp.MustCompile(`^[A-Z2-9]{4}-[A-Z2-9]{4}$`)
	hashPattern := regexp.MustCompile(`^[0-9a-f]{64}$`)
	seen := map[string]bool{}
	for i := range plain {
		if !codePattern.MatchString(plain[i]) {
			t.Errorf("code[%d] = %q does not match XXXX-XXXX format", i, plain[i])
		}
		if !hashPattern.MatchString(hashes[i]) {
			t.Errorf("hash[%d] = %q is not lowercase 64-char hex SHA-256", i, hashes[i])
		}
		if seen[plain[i]] {
			t.Errorf("duplicate recovery code generated: %q", plain[i])
		}
		seen[plain[i]] = true

		// Exact match.
		if idx := MatchRecoveryCode(plain[i], hashes); idx != i {
			t.Errorf("MatchRecoveryCode(%q) = %d, want %d", plain[i], idx, i)
		}
		// Lowercase without dash & with extra spaces should still match.
		messy := "  " + strings.ToLower(strings.ReplaceAll(plain[i], "-", " ")) + " "
		if idx := MatchRecoveryCode(messy, hashes); idx != i {
			t.Errorf("MatchRecoveryCode(%q) = %d, want %d", messy, idx, i)
		}
	}

	if idx := MatchRecoveryCode("ZZZZ-ZZZZ", hashes); idx != -1 {
		t.Errorf("expected -1 for unknown code, got %d", idx)
	}
	if idx := MatchRecoveryCode("", hashes); idx != -1 {
		t.Errorf("expected -1 for empty input, got %d", idx)
	}
	if idx := MatchRecoveryCode(plain[0], nil); idx != -1 {
		t.Errorf("expected -1 for nil hashes, got %d", idx)
	}
}
