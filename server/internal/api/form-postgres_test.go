package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type pausedPublicFormStore struct {
	store.Store
	entered, release         chan struct{}
	readEntered, readRelease chan struct{}
	once                     sync.Once
}

func (p *pausedPublicFormStore) SetPublicFormToken(ctx context.Context, guard store.BaseWriteGuard, baseID, viewID, expected int64, hash []byte, snapshot *store.PublicFormPublishSnapshot) (int64, error) {
	if expected == 0 && len(hash) != 0 {
		p.once.Do(func() { close(p.entered); <-p.release })
	}
	return p.Store.SetPublicFormToken(ctx, guard, baseID, viewID, expected, hash, snapshot)
}

func (p *pausedPublicFormStore) ReadPublicForm(ctx context.Context, baseID, viewID int64, hash []byte) (store.View, []store.Field, error) {
	v, fields, err := p.Store.ReadPublicForm(ctx, baseID, viewID, hash)
	if p.readEntered != nil && err == nil {
		close(p.readEntered)
		<-p.readRelease
	}
	return v, fields, err
}

func TestPostgresPublicFormHTTPFence(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_form_http_%d", time.Now().UnixNano())
	quoted := pgx.Identifier{schema}.Sanitize()
	defer func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+quoted+" CASCADE")
		admin.Close()
	}()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		t.Fatal(err)
	}
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	st := &store.Postgres{Pool: pool}
	paused := &pausedPublicFormStore{Store: st, entered: make(chan struct{}), release: make(chan struct{})}
	ts, owner := newTestServer(t, paused, nil)
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "form-pg@example.test", "name": "F", "password": "password123"})
	var base store.DocMeta
	resp := post(t, owner, ts.URL+"/api/bases", nil)
	if err := json.NewDecoder(resp.Body).Decode(&base); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	fields, err := st.Fields(ctx, base.ID)
	if err != nil || len(fields) == 0 {
		t.Fatalf("fields=%v err=%v", fields, err)
	}
	config, _ := json.Marshal(map[string]any{"fields": []int64{fields[0].ID}})
	view, err := st.AddView(ctx, store.View{BaseID: base.ID, Type: "form", Name: "F", Config: config})
	if err != nil {
		t.Fatal(err)
	}
	baseURL := ts.URL + "/api/bases/" + strconv.FormatInt(base.ID, 10)
	adminURL := baseURL + "/views/" + strconv.FormatInt(view.ID, 10) + "/public-form"
	firstSnapshot := publicationTestBody(t, owner, baseURL, view.ID, 0)
	// A real HTTP publication paused before storage must not resurrect the
	// link after another tab closes the unpublished revision-0 form.
	lateStatus := make(chan int, 1)
	go func() {
		r := post(t, owner, adminURL, firstSnapshot)
		lateStatus <- r.StatusCode
		r.Body.Close()
	}()
	<-paused.entered
	resp = send(t, owner, http.MethodDelete, adminURL, map[string]any{"expectedRevision": 0})
	resp.Body.Close()
	close(paused.release)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("close=%d", resp.StatusCode)
	}
	if status := <-lateStatus; status != http.StatusConflict {
		t.Fatalf("late publish=%d", status)
	}
	// Two managers/tabs using one revision cannot both publish.
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	secondSnapshot := publicationTestBody(t, owner, baseURL, view.ID, 1)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := post(t, owner, adminURL, secondSnapshot)
			statuses <- r.StatusCode
			r.Body.Close()
		}()
	}
	wg.Wait()
	close(statuses)
	ok, conflict := 0, 0
	for status := range statuses {
		if status == http.StatusOK {
			ok++
		} else if status == http.StatusConflict {
			conflict++
		} else {
			t.Fatalf("parallel status=%d", status)
		}
	}
	if ok != 1 || conflict != 1 {
		t.Fatalf("parallel ok=%d conflict=%d", ok, conflict)
	}
	resp = send(t, owner, http.MethodDelete, adminURL, map[string]any{"expectedRevision": 2})
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("close published=%d", resp.StatusCode)
	}
	resp = post(t, owner, adminURL, secondSnapshot)
	resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("stale publish after close=%d", resp.StatusCode)
	}
	// A definition read that began before close must recheck its token before
	// responding; the old snapshot must not be returned after revocation.
	token := publishTestForm(t, owner, baseURL, view.ID)
	paused.readEntered, paused.readRelease = make(chan struct{}), make(chan struct{})
	readStatus := make(chan int, 1)
	go func() {
		r, err := http.Get(ts.URL + "/api/forms/" + token)
		if err != nil {
			readStatus <- 0
			return
		}
		readStatus <- r.StatusCode
		r.Body.Close()
	}()
	<-paused.readEntered
	resp = send(t, owner, http.MethodDelete, adminURL, map[string]any{"expectedRevision": 4})
	resp.Body.Close()
	close(paused.readRelease)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("close while reading=%d", resp.StatusCode)
	}
	if status := <-readStatus; status != http.StatusNotFound {
		t.Fatalf("revoked in-flight read=%d", status)
	}
}
