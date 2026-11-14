package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestAIImagePreviewProviderFormatsAndValidation(t *testing.T) {
	var received map[string]any
	var calls int
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Error(err)
			return
		}
		if r.URL.Path == "/v1/messages" {
			fmt.Fprint(w, `{"content":[{"type":"text","text":"ok"}]}`)
		} else {
			fmt.Fprint(w, `{"choices":[{"message":{"content":"ok"}}]}`)
		}
	}))
	defer provider.Close()
	st := store.NewMemory()
	ts, client := newAITestServer(t, st, AISecretFromEnv("vision-test"))
	post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "vision@example.test", "name": "Owner", "password": "password123"})
	var b store.DocMeta
	if err := json.NewDecoder(post(t, client, ts.URL+"/api/bases", nil).Body).Decode(&b); err != nil {
		t.Fatal(err)
	}
	var pngBytes bytes.Buffer
	if err := png.Encode(&pngBytes, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	call := func(account string, data []byte) int {
		t.Helper()
		var body bytes.Buffer
		m := multipart.NewWriter(&body)
		_ = m.WriteField("messages", `[{"role":"system","content":"schema"},{"role":"user","content":"extract"}]`)
		part, _ := m.CreateFormFile("image", "test.png")
		_, _ = part.Write(data)
		_ = m.Close()
		req, _ := http.NewRequest("POST", ts.URL+"/api/bases/"+strconv.FormatInt(b.ID, 10)+"/ai-image-import-preview", &body)
		req.Header.Set("Content-Type", m.FormDataContentType())
		req.Header.Set("X-Jiange-Upload", "1")
		if account != "" {
			req.Header.Set("X-Jiange-User-Id", account)
		}
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		_, _ = io.Copy(io.Discard, res.Body)
		return res.StatusCode
	}
	account := strconv.FormatInt(b.CreatorID, 10)
	if got := call("", pngBytes.Bytes()); got != http.StatusUnauthorized {
		t.Fatalf("missing account=%d", got)
	}
	if got := call("999999", pngBytes.Bytes()); got != http.StatusUnauthorized {
		t.Fatalf("wrong account=%d", got)
	}
	if got := call(account, []byte("not an image")); got != http.StatusBadRequest {
		t.Fatalf("spoofed image=%d", got)
	}
	if got := call(account, pngBytes.Bytes()[:20]); got != http.StatusBadRequest {
		t.Fatalf("truncated image=%d", got)
	}
	if got := call(account, bytes.Repeat([]byte{'x'}, maxAIImageBytes+1)); got != http.StatusBadRequest {
		t.Fatalf("oversized image=%d", got)
	}
	if calls != 0 {
		t.Fatal("invalid request reached provider")
	}
	if res := send(t, client, "PUT", ts.URL+"/api/me/ai", map[string]string{"provider": "openai", "baseUrl": provider.URL + "/v1", "apiKey": "test-key-12345"}); res.StatusCode != 200 {
		t.Fatalf("settings=%d", res.StatusCode)
	}
	if got := call(account, pngBytes.Bytes()); got != 200 {
		t.Fatalf("openai=%d", got)
	}
	turns := received["messages"].([]any)
	user := turns[1].(map[string]any)
	parts := user["content"].([]any)
	uri := parts[1].(map[string]any)["image_url"].(map[string]any)["url"].(string)
	if uri != "data:image/png;base64,"+base64.StdEncoding.EncodeToString(pngBytes.Bytes()) {
		t.Fatal("wrong openai image payload")
	}
	if res := send(t, client, "PUT", ts.URL+"/api/me/ai", map[string]string{"provider": "anthropic", "baseUrl": provider.URL + "/v1"}); res.StatusCode != 200 {
		t.Fatalf("settings=%d", res.StatusCode)
	}
	if got := call(account, pngBytes.Bytes()); got != 200 {
		t.Fatalf("anthropic=%d", got)
	}
	turns = received["messages"].([]any)
	parts = turns[0].(map[string]any)["content"].([]any)
	source := parts[0].(map[string]any)["source"].(map[string]any)
	if source["media_type"] != "image/png" || source["data"] != base64.StdEncoding.EncodeToString(pngBytes.Bytes()) || received["system"] != "schema" {
		t.Fatal("wrong anthropic image payload")
	}
	if strings.Contains(fmt.Sprint(received), "test-key") {
		t.Fatal("secret included in model content")
	}
}

func TestAIImagePreviewRejectsRestrictedView(t *testing.T) {
	f := newBaseSecurityFixture(t)
	setLockedFixture(t, f)
	root := f.url[:strings.Index(f.url, "/api/")]
	var me struct {
		User store.User `json:"user"`
	}
	if err := json.NewDecoder(cGet(t, f.guest, root+"/api/me").Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	var body bytes.Buffer
	m := multipart.NewWriter(&body)
	_ = m.WriteField("messages", `[{"role":"system","content":"schema"},{"role":"user","content":"extract"}]`)
	part, _ := m.CreateFormFile("image", "test.png")
	_ = png.Encode(part, image.NewRGBA(image.Rect(0, 0, 2, 2)))
	_ = m.Close()
	req, _ := http.NewRequest("POST", f.url+"/ai-image-import-preview", &body)
	req.Header.Set("Content-Type", m.FormDataContentType())
	req.Header.Set("X-Jiange-Upload", "1")
	req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(me.User.ID, 10))
	res, err := f.guest.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("restricted view=%d", res.StatusCode)
	}
}
