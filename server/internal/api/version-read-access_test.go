package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"strconv"
	"strings"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

type versionReadRaceStore struct {
	*store.Memory
	afterVersionRead func()
}

func (s *versionReadRaceStore) VersionState(ctx context.Context, doc, seq int64) ([]byte, error) {
	state, err := s.Memory.VersionState(ctx, doc, seq)
	if s.afterVersionRead != nil {
		hook := s.afterVersionRead
		s.afterVersionRead = nil
		hook()
	}
	return state, err
}

func TestVersionReadAccess(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemory()
	traced := &versionReadRaceStore{Memory: st}
	ts, owner := newTestServer(t, traced, nil)
	register := func(c *http.Client, email string) store.User {
		t.Helper()
		res := post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": email, "name": email, "password": "password123"})
		defer res.Body.Close()
		var body struct {
			User store.User `json:"user"`
		}
		if res.StatusCode != http.StatusCreated || json.NewDecoder(res.Body).Decode(&body) != nil {
			t.Fatalf("register: %d", res.StatusCode)
		}
		return body.User
	}
	ownerUser := register(owner, "version-owner@test.dev")
	jar, _ := cookiejar.New(nil)
	viewer := &http.Client{Jar: jar}
	viewerUser := register(viewer, "version-viewer@test.dev")
	res := post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "权限测试"})
	var doc store.DocMeta
	if res.StatusCode != http.StatusCreated || json.NewDecoder(res.Body).Decode(&doc) != nil {
		t.Fatalf("create doc: %d", res.StatusCode)
	}
	res.Body.Close()
	if err := st.SetShare(ctx, doc.ID, viewerUser.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	s := &Server{Store: st}
	seedDoc(t, s, doc.ID, "自动历史内容")
	if n, err := SweepAutomaticVersions(ctx, st, nil); err != nil || n != 1 {
		t.Fatalf("sweep: %d %v", n, err)
	}
	_, autoSeq, _ := st.HeadVersion(ctx, doc.ID)
	seedDoc(t, s, doc.ID, "明确保存内容")
	epoch, savedSeq, _ := st.HeadVersion(ctx, doc.ID)
	base := ts.URL + "/api/docs/" + strconv.FormatInt(doc.ID, 10)
	createNamed := func(seq, epoch int64, label, requestID string) {
		t.Helper()
		body := `{"label":"` + label + `","historyEpoch":` + strconv.FormatInt(epoch, 10) + `,"expectedSeq":` + strconv.FormatInt(seq, 10) + `,"requestId":"` + requestID + `"}`
		req, _ := http.NewRequest("POST", base+"/version-entries", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(ownerUser.ID, 10))
		r, err := owner.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		if r.StatusCode != 201 {
			b, _ := io.ReadAll(r.Body)
			t.Fatalf("save: %d %s", r.StatusCode, b)
		}
	}
	createNamed(savedSeq, epoch, "交付版", strings.Repeat("a", 32))
	get := func(c *http.Client, uid int64, path string) (int, string) {
		t.Helper()
		req, _ := http.NewRequest("GET", base+path, nil)
		req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(uid, 10))
		r, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		b, _ := io.ReadAll(r.Body)
		if r.Header.Get("Cache-Control") != "private, no-store" {
			t.Fatalf("missing cache control: %q", r.Header.Get("Cache-Control"))
		}
		return r.StatusCode, string(b)
	}
	for _, endpoint := range []string{"/version-entries", "/versions"} {
		code, body := get(viewer, viewerUser.ID, endpoint)
		if code != 200 || strings.Contains(body, "自动保存") || !strings.Contains(body, "交付版") {
			t.Fatalf("viewer %s: %d %s", endpoint, code, body)
		}
		code, _ = get(viewer, viewerUser.ID, endpoint+"?scope=history")
		if code != 403 {
			t.Fatalf("viewer history %s: %d", endpoint, code)
		}
		code, body = get(owner, ownerUser.ID, endpoint+"?scope=history")
		if code != 200 || !strings.Contains(body, "自动保存") || !strings.Contains(body, "交付版") {
			t.Fatalf("editor history %s: %d %s", endpoint, code, body)
		}
		code, body = get(owner, ownerUser.ID, endpoint+"?scope=saved")
		if code != 200 || strings.Contains(body, "自动保存") || !strings.Contains(body, "交付版") {
			t.Fatalf("editor saved %s: %d %s", endpoint, code, body)
		}
		code, _ = get(owner, ownerUser.ID, endpoint+"?scope=saved&scope=history")
		if code != 400 {
			t.Fatalf("invalid scope %s: %d", endpoint, code)
		}
	}
	autoPath := "/versions/" + strconv.FormatInt(autoSeq, 10)
	savedPath := "/versions/" + strconv.FormatInt(savedSeq, 10)
	if code, _ := get(viewer, viewerUser.ID, autoPath); code != 404 {
		t.Fatalf("viewer automatic preview %d", code)
	}
	if code, body := get(owner, ownerUser.ID, autoPath); code != 200 || !strings.Contains(body, "自动历史内容") {
		t.Fatalf("editor automatic preview %d %s", code, body)
	}
	if code, body := get(viewer, viewerUser.ID, savedPath); code != 200 || !strings.Contains(body, "明确保存内容") {
		t.Fatalf("viewer saved preview %d %s", code, body)
	}
	seedDoc(t, s, doc.ID, "同一快照")
	if n, err := SweepAutomaticVersions(ctx, st, nil); err != nil || n != 1 {
		t.Fatalf("third sweep %d %v", n, err)
	}
	epoch, aliasSeq, _ := st.HeadVersion(ctx, doc.ID)
	createNamed(aliasSeq, epoch, "同一快照已存", strings.Repeat("b", 32))
	if code, body := get(viewer, viewerUser.ID, "/versions/"+strconv.FormatInt(aliasSeq, 10)); code != 200 || !strings.Contains(body, "同一快照") {
		t.Fatalf("saved alias preview %d %s", code, body)
	}
	if code, body := get(viewer, viewerUser.ID, "/versions"); code != 200 || !strings.Contains(body, "同一快照已存") || strings.Contains(body, "自动保存") {
		t.Fatalf("saved alias list %d %s", code, body)
	}
	if err := st.SetShare(ctx, doc.ID, viewerUser.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	traced.afterVersionRead = func() {
		if err := st.SetShare(ctx, doc.ID, viewerUser.ID, store.RoleView); err != nil {
			t.Error(err)
		}
	}
	if code, body := get(viewer, viewerUser.ID, autoPath); code != 404 || strings.Contains(body, "自动历史内容") {
		t.Fatalf("downgraded during snapshot read: %d %s", code, body)
	}
}
