package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/textproto"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/blob"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func newSharePasswordTestServer(t *testing.T, st store.Store) (*httptest.Server, *Server, *http.Client) {
	t.Helper()
	s := &Server{
		Store:      st,
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL: time.Hour,
		Iterations: 100,
		Blobs:      blob.NewMemory(),
		AISecret:   []byte("0123456789abcdef0123456789abcdef"),
	}
	base := s.Handler()
	mux := http.NewServeMux()
	mux.Handle("PUT /api/docs/{id}/link-password", httpx.RequireJSON(s.requireUser(http.HandlerFunc(s.putLinkPassword))))
	mux.Handle("POST /api/public/{token}/verify-password", httpx.RequireJSON(http.HandlerFunc(s.verifyPublicLinkPassword)))
	mux.Handle("/", base)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	jar, _ := cookiejar.New(nil)
	return ts, s, &http.Client{Jar: jar}
}

func decodeJSONError(t *testing.T, body io.Reader) (string, string) {
	t.Helper()
	var out struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if err := json.NewDecoder(body).Decode(&out); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	return out.Error, out.Message
}

func TestShareLinkPasswordFullFlow(t *testing.T) {
	st := store.NewMemory()
	ts, _, owner := newSharePasswordTestServer(t, st)
	client := func() *http.Client { j, _ := cookiejar.New(nil); return &http.Client{Jar: j} }
	editor, guest, anon := client(), client(), client()

	var ownerMe, guestMe meResponse
	r := post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "pw-owner@x.test", "name": "Owner", "password": "password123"})
	json.NewDecoder(r.Body).Decode(&ownerMe)
	r.Body.Close()
	post(t, editor, ts.URL+"/api/auth/register", map[string]string{"email": "pw-editor@x.test", "name": "Editor", "password": "password123"}).Body.Close()
	r = post(t, guest, ts.URL+"/api/auth/register", map[string]string{"email": "pw-guest@x.test", "name": "Guest", "password": "password123"})
	json.NewDecoder(r.Body).Decode(&guestMe)
	r.Body.Close()

	var doc store.DocMeta
	r = post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "绝密产品路线图"})
	json.NewDecoder(r.Body).Decode(&doc)
	r.Body.Close()
	docURL := fmt.Sprintf("%s/api/docs/%d", ts.URL, doc.ID)

	// Share edit role with editor so we can verify non-manager gets 403.
	if res := send(t, owner, "PUT", docURL+"/shares", map[string]string{"email": "pw-editor@x.test", "role": "edit"}); res.StatusCode != 200 {
		t.Fatalf("invite editor: %d", res.StatusCode)
	} else {
		res.Body.Close()
	}

	// Upload a public image attachment referenced in the doc to verify /api/public/{token}/files/{id} gate.
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	hdr := textproto.MIMEHeader{}
	hdr.Set("Content-Disposition", `form-data; name="file"; filename="diagram.png"`)
	hdr.Set("Content-Type", "image/png")
	fw, _ := mw.CreatePart(hdr)
	fw.Write([]byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde"))
	mw.Close()
	upReq, _ := http.NewRequest("POST", docURL+"/files", &buf)
	upReq.Header.Set("Content-Type", mw.FormDataContentType())
	upReq.Header.Set("X-Jiange-Upload", "1")
	upRes, err := owner.Do(upReq)
	if err != nil {
		t.Fatal(err)
	}
	var file store.FileMeta
	json.NewDecoder(upRes.Body).Decode(&file)
	upRes.Body.Close()
	if upRes.StatusCode != 201 {
		t.Fatalf("upload: %d", upRes.StatusCode)
	}
	referenceTestFile(t, st, doc.ID, file.ID, "image")

	// Enable anon link sharing.
	var linkResp struct {
		store.Link
		HasPassword bool `json:"hasPassword"`
	}
	res := send(t, owner, "PUT", docURL+"/link", map[string]string{"role": "anon"})
	json.NewDecoder(res.Body).Decode(&linkResp)
	res.Body.Close()
	if res.StatusCode != 200 || linkResp.Token == "" || linkResp.HasPassword {
		t.Fatalf("open anon link: status=%d resp=%+v", res.StatusCode, linkResp)
	}
	tok := linkResp.Token

	// Without password, verify-password returns 200 {ok: true}.
	vRes := post(t, anon, ts.URL+"/api/public/"+tok+"/verify-password", map[string]string{"password": ""})
	if vRes.StatusCode != 200 {
		t.Fatalf("verify without password: %d", vRes.StatusCode)
	}
	vRes.Body.Close()

	// Inactive token returns 404 on verify-password.
	vRes = post(t, anon, ts.URL+"/api/public/nonexistent-token/verify-password", map[string]string{"password": "1234"})
	if vRes.StatusCode != 404 {
		t.Fatalf("verify missing token: %d", vRes.StatusCode)
	}
	vRes.Body.Close()

	// Non-manager (editor) gets 403 on PUT /link-password.
	res = send(t, editor, "PUT", docURL+"/link-password", map[string]any{"password": "abcd"})
	if res.StatusCode != 403 {
		t.Fatalf("editor set link password: want 403 got %d", res.StatusCode)
	}
	res.Body.Close()

	// Validation: too short, too long, control characters rejected with 400.
	for _, bad := range []string{"abc", "  123  ", strings.Repeat("a", 33), "ab\ncd"} {
		res = send(t, owner, "PUT", docURL+"/link-password", map[string]any{"password": bad})
		if res.StatusCode != 400 {
			t.Fatalf("bad password %q: want 400 got %d", bad, res.StatusCode)
		}
		res.Body.Close()
	}

	// Owner sets password "  pass2026  " (trimmed -> "pass2026").
	res = send(t, owner, "PUT", docURL+"/link-password", map[string]any{"password": "  pass2026  "})
	var setOut struct {
		HasPassword bool `json:"hasPassword"`
	}
	json.NewDecoder(res.Body).Decode(&setOut)
	res.Body.Close()
	if res.StatusCode != 200 || !setOut.HasPassword {
		t.Fatalf("set password: status=%d out=%+v", res.StatusCode, setOut)
	}

	// Audit log should capture share.link_update with hasPassword=true.
	auditReq, _ := http.NewRequest("GET", fmt.Sprintf("%s/api/workspaces/%d/audit-logs?action=share.link_update", ts.URL, doc.WorkspaceID), nil)
	auditReq.Header.Set("X-Jiange-User-Id", strconv.FormatInt(ownerMe.User.ID, 10))
	auditRes, err := owner.Do(auditReq)
	if err != nil {
		t.Fatal(err)
	}
	var auditPage store.AuditLogPage
	json.NewDecoder(auditRes.Body).Decode(&auditPage)
	auditRes.Body.Close()
	if auditRes.StatusCode != 200 {
		t.Fatalf("audit logs: %d", auditRes.StatusCode)
	}
	foundAudit := false
	for _, item := range auditPage.Items {
		if strings.Contains(string(item.Detail), `"hasPassword":true`) {
			foundAudit = true
			break
		}
	}
	if !foundAudit {
		t.Fatalf("expected share.link_update audit log with hasPassword:true, got %+v", auditPage.Items)
	}

	// GET /shares and /shares-account both report hasPassword: true.
	for _, path := range []string{"/shares", "/shares-account"} {
		req, _ := http.NewRequest("GET", docURL+path, nil)
		if path == "/shares-account" {
			req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(ownerMe.User.ID, 10))
		}
		r, err := owner.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var sh struct {
			HasPassword bool `json:"hasPassword"`
		}
		json.NewDecoder(r.Body).Decode(&sh)
		r.Body.Close()
		if r.StatusCode != 200 || !sh.HasPassword {
			t.Fatalf("%s hasPassword: status=%d sh=%+v", path, r.StatusCode, sh)
		}
	}

	// Anonymous GET /api/public/{token} returns 403 password_required and leaks ZERO doc content.
	pubRes, err := anon.Get(ts.URL + "/api/public/" + tok)
	if err != nil {
		t.Fatal(err)
	}
	pubBody, _ := io.ReadAll(pubRes.Body)
	pubRes.Body.Close()
	if pubRes.StatusCode != 403 || bytes.Contains(pubBody, []byte("绝密产品路线图")) {
		t.Fatalf("gated public get: status=%d body=%s", pubRes.StatusCode, pubBody)
	}
	if code, _ := decodeJSONError(t, bytes.NewReader(pubBody)); code != "password_required" {
		t.Fatalf("gated public code: %q", code)
	}

	// Public file endpoint is also gated before verification.
	fileURL := fmt.Sprintf("%s/api/public/%s/files/%d", ts.URL, tok, file.ID)
	fRes, err := anon.Get(fileURL)
	if err != nil {
		t.Fatal(err)
	}
	fCode, _ := decodeJSONError(t, fRes.Body)
	fRes.Body.Close()
	if fRes.StatusCode != 403 || fCode != "password_required" {
		t.Fatalf("gated public file: status=%d code=%q", fRes.StatusCode, fCode)
	}

	// Authenticated join without password also returns 403 password_required.
	jRes := post(t, guest, ts.URL+"/api/share/"+tok, nil)
	jCode, _ := decodeJSONError(t, jRes.Body)
	jRes.Body.Close()
	if jRes.StatusCode != 403 || jCode != "password_required" {
		t.Fatalf("gated join: status=%d code=%q", jRes.StatusCode, jCode)
	}
	jgReq, _ := http.NewRequest("POST", ts.URL+"/api/share/"+tok+"/join-guarded", nil)
	jgReq.Header.Set("X-Jiange-User-Id", strconv.FormatInt(guestMe.User.ID, 10))
	jgRes, err := guest.Do(jgReq)
	if err != nil {
		t.Fatal(err)
	}
	jgCode, _ := decodeJSONError(t, jgRes.Body)
	jgRes.Body.Close()
	if jgRes.StatusCode != 403 || jgCode != "password_required" {
		t.Fatalf("gated join-guarded: status=%d code=%q", jgRes.StatusCode, jgCode)
	}

	// Wrong password on /verify-password returns 403 invalid_password and sets no cookie.
	vRes = post(t, anon, ts.URL+"/api/public/"+tok+"/verify-password", map[string]string{"password": "wrong-pass"})
	vCode, _ := decodeJSONError(t, vRes.Body)
	vCookies := vRes.Cookies()
	vRes.Body.Close()
	if vRes.StatusCode != 403 || vCode != "invalid_password" || len(vCookies) != 0 {
		t.Fatalf("wrong password: status=%d code=%q cookies=%d", vRes.StatusCode, vCode, len(vCookies))
	}

	// X-Share-Password header unlocks direct API access without cookie.
	hdrReq, _ := http.NewRequest("GET", ts.URL+"/api/public/"+tok, nil)
	hdrReq.Header.Set("X-Share-Password", "pass2026")
	hdrRes, err := (&http.Client{}).Do(hdrReq)
	if err != nil {
		t.Fatal(err)
	}
	hdrRes.Body.Close()
	if hdrRes.StatusCode != 200 {
		t.Fatalf("header unlock: want 200 got %d", hdrRes.StatusCode)
	}

	// Correct password sets HttpOnly cookie and unlocks GET /api/public/{token} + files.
	vRes = post(t, anon, ts.URL+"/api/public/"+tok+"/verify-password", map[string]string{"password": "pass2026"})
	var verifyOut struct {
		OK bool `json:"ok"`
	}
	json.NewDecoder(vRes.Body).Decode(&verifyOut)
	setCookies := vRes.Cookies()
	vRes.Body.Close()
	if vRes.StatusCode != 200 || !verifyOut.OK || len(setCookies) != 1 {
		t.Fatalf("correct password verify: status=%d out=%+v cookies=%d", vRes.StatusCode, verifyOut, len(setCookies))
	}
	if !strings.HasPrefix(setCookies[0].Name, "jiange_lp_") || !setCookies[0].HttpOnly || setCookies[0].MaxAge != 86400 || setCookies[0].Path != "/" {
		t.Fatalf("unexpected cookie attributes: %+v", setCookies[0])
	}

	pubRes, err = anon.Get(ts.URL + "/api/public/" + tok)
	if err != nil {
		t.Fatal(err)
	}
	var snap struct {
		Title string `json:"title"`
	}
	json.NewDecoder(pubRes.Body).Decode(&snap)
	pubRes.Body.Close()
	if pubRes.StatusCode != 200 || snap.Title != "绝密产品路线图" {
		t.Fatalf("unlocked public get: status=%d snap=%+v", pubRes.StatusCode, snap)
	}

	// Public file now succeeds with cookie.
	fRes, err = anon.Get(fileURL)
	if err != nil {
		t.Fatal(err)
	}
	fRes.Body.Close()
	if fRes.StatusCode != 200 {
		t.Fatalf("unlocked public file: %d", fRes.StatusCode)
	}

	// Guest verifies password -> unlocks POST /api/share/{token} and /join-guarded.
	vRes = post(t, guest, ts.URL+"/api/public/"+tok+"/verify-password", map[string]string{"password": "pass2026"})
	if vRes.StatusCode != 200 {
		t.Fatalf("guest verify: %d", vRes.StatusCode)
	}
	vRes.Body.Close()

	jRes = post(t, guest, ts.URL+"/api/share/"+tok, nil)
	var joined store.DocMeta
	json.NewDecoder(jRes.Body).Decode(&joined)
	jRes.Body.Close()
	if jRes.StatusCode != 200 || joined.ID != doc.ID {
		t.Fatalf("unlocked join: status=%d doc=%+v", jRes.StatusCode, joined)
	}

	jgReq, _ = http.NewRequest("POST", ts.URL+"/api/share/"+tok+"/join-guarded", nil)
	jgReq.Header.Set("X-Jiange-User-Id", strconv.FormatInt(guestMe.User.ID, 10))
	jgRes, err = guest.Do(jgReq)
	if err != nil {
		t.Fatal(err)
	}
	jgRes.Body.Close()
	if jgRes.StatusCode != 200 {
		t.Fatalf("unlocked join-guarded: %d", jgRes.StatusCode)
	}

	// Changing password IMMEDIATELY invalidates old cookies!
	res = send(t, owner, "PUT", docURL+"/link-password", map[string]any{"password": "newpass99"})
	if res.StatusCode != 200 {
		t.Fatalf("rotate password: %d", res.StatusCode)
	}
	res.Body.Close()

	pubRes, err = anon.Get(ts.URL + "/api/public/" + tok)
	if err != nil {
		t.Fatal(err)
	}
	staleCode, _ := decodeJSONError(t, pubRes.Body)
	pubRes.Body.Close()
	if pubRes.StatusCode != 403 || staleCode != "password_required" {
		t.Fatalf("old cookie after password change: status=%d code=%q", pubRes.StatusCode, staleCode)
	}
	// Old X-Share-Password fails too.
	hdrReq, _ = http.NewRequest("GET", ts.URL+"/api/public/"+tok, nil)
	hdrReq.Header.Set("X-Share-Password", "pass2026")
	hdrRes, _ = (&http.Client{}).Do(hdrReq)
	hdrRes.Body.Close()
	if hdrRes.StatusCode != 403 {
		t.Fatalf("old header after rotation: want 403 got %d", hdrRes.StatusCode)
	}

	// Clearing password restores open access without needing any cookie or header.
	res = send(t, owner, "PUT", docURL+"/link-password", map[string]any{"clear": true})
	setOut = struct {
		HasPassword bool `json:"hasPassword"`
	}{}
	json.NewDecoder(res.Body).Decode(&setOut)
	res.Body.Close()
	if res.StatusCode != 200 || setOut.HasPassword {
		t.Fatalf("clear password: status=%d out=%+v", res.StatusCode, setOut)
	}

	freshAnon := &http.Client{}
	pubRes, err = freshAnon.Get(ts.URL + "/api/public/" + tok)
	if err != nil {
		t.Fatal(err)
	}
	pubRes.Body.Close()
	if pubRes.StatusCode != 200 {
		t.Fatalf("open access after clear: want 200 got %d", pubRes.StatusCode)
	}

	// Setting a password and then closing link (role="none") clears stored password so re-opening starts clean.
	res = send(t, owner, "PUT", docURL+"/link-password", map[string]any{"password": "temp7777"})
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("re-set password: %d", res.StatusCode)
	}
	// Close via guarded revision endpoint (used by ShareDialog).
	closeReq, _ := http.NewRequest("PUT", docURL+"/link-guarded", bytes.NewBufferString(fmt.Sprintf(`{"role":"none","expectedRevision":%d}`, linkResp.Revision)))
	closeReq.Header.Set("Content-Type", "application/json")
	closeReq.Header.Set("X-Jiange-User-Id", strconv.FormatInt(ownerMe.User.ID, 10))
	closeRes, err := owner.Do(closeReq)
	if err != nil {
		t.Fatal(err)
	}
	var closedLink struct {
		store.Link
		HasPassword bool `json:"hasPassword"`
	}
	json.NewDecoder(closeRes.Body).Decode(&closedLink)
	closeRes.Body.Close()
	if closeRes.StatusCode != 200 || closedLink.Role != "none" || closedLink.HasPassword {
		t.Fatalf("close guarded link: status=%d resp=%+v", closeRes.StatusCode, closedLink)
	}
	if h, err := st.GetLinkPasswordHash(context.Background(), doc.ID); err != nil || h != "" {
		t.Fatalf("password should be cleared when link closed: hash=%q err=%v", h, err)
	}

	// Re-enabling link starts without a stale password.
	res = send(t, owner, "PUT", docURL+"/link", map[string]string{"role": "anon"})
	linkResp = struct {
		store.Link
		HasPassword bool `json:"hasPassword"`
	}{}
	json.NewDecoder(res.Body).Decode(&linkResp)
	res.Body.Close()
	if res.StatusCode != 200 || linkResp.HasPassword || linkResp.Token == "" {
		t.Fatalf("reopened link: status=%d resp=%+v", res.StatusCode, linkResp)
	}
	pubRes, err = freshAnon.Get(ts.URL + "/api/public/" + linkResp.Token)
	if err != nil {
		t.Fatal(err)
	}
	pubRes.Body.Close()
	if pubRes.StatusCode != 200 {
		t.Fatalf("reopened link should be open: %d", pubRes.StatusCode)
	}
}
