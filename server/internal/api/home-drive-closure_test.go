package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/blob"
	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func runHomeDriveClosureSuite(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	blobs := blob.NewMemory()
	s := &Server{
		Store:      st,
		Blobs:      blobs,
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL: time.Hour,
		Iterations: 100,
	}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	newClient := func() *http.Client {
		j, _ := cookiejar.New(nil)
		return &http.Client{Jar: j}
	}
	owner, guest := newClient(), newClient()
	register := func(c *http.Client, email, name string) store.User {
		t.Helper()
		r := post(t, c, ts.URL+"/api/auth/register", map[string]string{
			"email": email, "name": name, "password": "password123",
		})
		defer r.Body.Close()
		if r.StatusCode != http.StatusCreated {
			t.Fatalf("register %s: %d", email, r.StatusCode)
		}
		var out struct {
			User store.User `json:"user"`
		}
		if err := json.NewDecoder(r.Body).Decode(&out); err != nil {
			t.Fatal(err)
		}
		return out.User
	}
	ownerUser := register(owner, "hd-owner@example.test", "Owner")
	guestUser := register(guest, "hd-guest@example.test", "Guest")
	ownerHeader := map[string]string{"X-Jiange-User-Id": strconv.FormatInt(ownerUser.ID, 10)}
	guestHeader := map[string]string{"X-Jiange-User-Id": strconv.FormatInt(guestUser.ID, 10)}

	postWith := func(c *http.Client, url string, body any, headers map[string]string) *http.Response {
		t.Helper()
		b, _ := json.Marshal(body)
		req, err := http.NewRequest(http.MethodPost, url, io.NopCloser(bytesReader(b)))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		res, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	delWith := func(c *http.Client, url string, headers map[string]string) *http.Response {
		t.Helper()
		req, err := http.NewRequest(http.MethodDelete, url, nil)
		if err != nil {
			t.Fatal(err)
		}
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		res, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}

	// 1. Create target personal folder in Drive.
	fRes := postWith(owner, ts.URL+"/api/drive/folders", map[string]any{"title": "归档目录", "scope": "personal"}, ownerHeader)
	if fRes.StatusCode != http.StatusCreated {
		t.Fatalf("create folder: %d", fRes.StatusCode)
	}
	var targetFolder store.DriveEntry
	if err := json.NewDecoder(fRes.Body).Decode(&targetFolder); err != nil {
		t.Fatal(err)
	}
	fRes.Body.Close()

	// 2. Create a multi-table Base with link, attachment, shared view, personal view, and locked view.
	bRes := postWith(owner, ts.URL+"/api/drive/nodes", map[string]any{"kind": "base", "title": "项目台账", "scope": "personal"}, ownerHeader)
	if bRes.StatusCode != http.StatusCreated {
		t.Fatalf("create base: %d", bRes.StatusCode)
	}
	var baseEntry store.DriveEntry
	if err := json.NewDecoder(bRes.Body).Decode(&baseEntry); err != nil {
		t.Fatal(err)
	}
	bRes.Body.Close()

	tables, err := st.BaseTables(ctx, baseEntry.ID)
	if err != nil || len(tables) != 1 {
		t.Fatalf("default base table: %v len=%d", err, len(tables))
	}
	t1 := tables[0]
	// Add second data table via HTTP API.
	t2Res := post(t, owner, ts.URL+"/api/bases/"+strconv.FormatInt(baseEntry.ID, 10)+"/tables", map[string]any{"name": "里程碑"})
	if t2Res.StatusCode != http.StatusCreated {
		t.Fatalf("create second table: %d", t2Res.StatusCode)
	}
	var t2 store.BaseTable
	if err := json.NewDecoder(t2Res.Body).Decode(&t2); err != nil {
		t.Fatal(err)
	}
	t2Res.Body.Close()
	if t2.ID <= 0 {
		t.Fatalf("expected created table ID > 0, got %+v", t2)
	}

	fields, err := st.Fields(ctx, baseEntry.ID)
	if err != nil {
		t.Fatal(err)
	}
	var t1Primary, t2Primary store.Field
	for _, f := range fields {
		if f.TableID == t1.ID && f.IsPrimary {
			t1Primary = f
		}
		if f.TableID == t2.ID && f.IsPrimary {
			t2Primary = f
		}
	}
	statusField, err := st.AddField(ctx, store.Field{
		BaseID: baseEntry.ID, TableID: t1.ID, Name: "状态", Type: "select", Options: []string{"进行中", "已完成"},
	})
	if err != nil {
		t.Fatal(err)
	}
	attachField, err := st.AddField(ctx, store.Field{
		BaseID: baseEntry.ID, TableID: t1.ID, Name: "附件", Type: "attachment",
	})
	if err != nil {
		t.Fatal(err)
	}
	linkField, err := st.AddField(ctx, store.Field{
		BaseID: baseEntry.ID, TableID: t1.ID, Name: "关联里程碑", Type: "link",
		Options:       []string{strconv.FormatInt(baseEntry.ID, 10)},
		TargetTableID: &t2.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := blobs.Put(ctx, "objects/base-copy-att", "text/plain", []byte("spec-v1")); err != nil {
		t.Fatal(err)
	}
	attFile, err := st.CreateFile(ctx, store.FileMeta{
		DocID: baseEntry.ID, UploaderID: ownerUser.ID, Name: "spec.txt", Mime: "text/plain", Size: 7, ObjectKey: "objects/base-copy-att",
	})
	if err != nil {
		t.Fatal(err)
	}
	t2Rec, err := st.AddRecord(ctx, store.Record{
		BaseID: baseEntry.ID, TableID: t2.ID,
		Cells: map[string]json.RawMessage{
			strconv.FormatInt(t2Primary.ID, 10): json.RawMessage(`"Q4 上线"`),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t1Rec, err := st.AddRecord(ctx, store.Record{
		BaseID: baseEntry.ID, TableID: t1.ID,
		Cells: map[string]json.RawMessage{
			strconv.FormatInt(t1Primary.ID, 10):   json.RawMessage(`"云盘闭环"`),
			strconv.FormatInt(statusField.ID, 10): json.RawMessage(`"进行中"`),
			strconv.FormatInt(attachField.ID, 10): json.RawMessage(fmt.Sprintf(`[{"id":%d,"name":"spec.txt","mime":"text/plain","size":7}]`, attFile.ID)),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetLinks(ctx, baseEntry.ID, linkField.ID, t1Rec.ID, []int64{t2Rec.ID}); err != nil {
		t.Fatal(err)
	}
	// Shared filtered view + personal view.
	sharedViewCfg := json.RawMessage(fmt.Sprintf(`{"filters":{"conj":"and","rules":[{"f":%d,"op":"is","v":"进行中"}]},"sorts":[{"f":%d,"asc":true}]}`, statusField.ID, t1Primary.ID))
	if _, err := st.AddView(ctx, store.View{BaseID: baseEntry.ID, TableID: t1.ID, Type: "grid", Name: "进行中视图", Config: sharedViewCfg}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AddView(ctx, store.View{BaseID: baseEntry.ID, TableID: t1.ID, OwnerID: &ownerUser.ID, Type: "grid", Name: "我的个人视图", Config: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}

	// Duplicate Base directly into targetFolder!
	dupBaseRes := postWith(owner, ts.URL+"/api/docs/"+strconv.FormatInt(baseEntry.ID, 10)+"/account-duplicate", map[string]any{
		"parentId": targetFolder.ID,
	}, ownerHeader)
	if dupBaseRes.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(dupBaseRes.Body)
		t.Fatalf("duplicate base into folder: %d %s", dupBaseRes.StatusCode, string(b))
	}
	var copiedBase store.DocMeta
	if err := json.NewDecoder(dupBaseRes.Body).Decode(&copiedBase); err != nil {
		t.Fatal(err)
	}
	dupBaseRes.Body.Close()
	if copiedBase.Kind != "base" || copiedBase.ParentID == nil || *copiedBase.ParentID != targetFolder.ID || copiedBase.Title != "项目台账 副本" {
		t.Fatalf("copied base meta mismatch: %+v", copiedBase)
	}

	// Verify copied Base has 2 tables, remapped fields, remapped link/records/attachments, shared views only.
	cpTables, err := st.BaseTables(ctx, copiedBase.ID)
	if err != nil || len(cpTables) != 2 {
		t.Fatalf("copied base tables: %v len=%d", err, len(cpTables))
	}
	cpFields, err := st.Fields(ctx, copiedBase.ID)
	if err != nil {
		t.Fatal(err)
	}
	var cpLinkField, cpAttachField, cpStatusField store.Field
	for _, f := range cpFields {
		switch f.Name {
		case "关联里程碑":
			cpLinkField = f
		case "附件":
			cpAttachField = f
		case "状态":
			cpStatusField = f
		}
	}
	if cpLinkField.ID == 0 || len(cpLinkField.Options) == 0 || cpLinkField.Options[0] != strconv.FormatInt(copiedBase.ID, 10) {
		t.Fatalf("copied link field not remapped to new base: %+v", cpLinkField)
	}
	if cpLinkField.TargetTableID == nil || *cpLinkField.TargetTableID == t2.ID {
		t.Fatalf("copied link field TargetTableID not remapped: %+v", cpLinkField)
	}
	cpRecords, err := st.Records(ctx, copiedBase.ID)
	if err != nil {
		t.Fatal(err)
	}
	foundCopiedRow := false
	for _, rec := range cpRecords {
		if raw, ok := rec.Cells[strconv.FormatInt(cpAttachField.ID, 10)]; ok {
			var items []struct {
				ID int64 `json:"id"`
			}
			if err := json.Unmarshal(raw, &items); err != nil || len(items) != 1 || items[0].ID == attFile.ID {
				t.Fatalf("copied attachment ID not remapped: %s", string(raw))
			}
			links, err := st.LinksForRecords(ctx, cpLinkField.ID, []int64{rec.ID})
			if err != nil || len(links[rec.ID]) != 1 || links[rec.ID][0] == t2Rec.ID {
				t.Fatalf("copied bt_links not remapped: %+v err=%v", links, err)
			}
			foundCopiedRow = true
		}
	}
	if !foundCopiedRow {
		t.Fatal("copied record with attachment and link not found")
	}
	cpViews, err := st.Views(ctx, copiedBase.ID)
	if err != nil {
		t.Fatal(err)
	}
	foundRemappedView := false
	for _, v := range cpViews {
		if v.Name == "我的个人视图" {
			t.Fatal("personal view should not be copied")
		}
		if v.Name == "进行中视图" {
			var cfg struct {
				Filters struct {
					Rules []struct {
						F int64 `json:"f"`
					} `json:"rules"`
				} `json:"filters"`
			}
			if err := json.Unmarshal(v.Config, &cfg); err != nil || len(cfg.Filters.Rules) != 1 || cfg.Filters.Rules[0].F != cpStatusField.ID {
				t.Fatalf("copied view config filter not remapped: %s (want field %d)", string(v.Config), cpStatusField.ID)
			}
			foundRemappedView = true
		}
	}
	if !foundRemappedView {
		t.Fatal("shared view missing from copied base")
	}

	// 3. Locked view protection: share base with guest as view; once locked view exists, guest CANNOT copy it.
	if err := st.SetShare(ctx, baseEntry.ID, guestUser.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	lockedCfg := json.RawMessage(fmt.Sprintf(`{"locked":true,"filters":{"conj":"and","rules":[{"f":%d,"op":"is","v":"进行中"}]}}`, statusField.ID))
	if _, err := st.AddView(ctx, store.View{BaseID: baseEntry.ID, TableID: t1.ID, Type: "grid", Name: "权限视图", Config: lockedCfg}); err != nil {
		t.Fatal(err)
	}
	guestCopyRes := postWith(guest, ts.URL+"/api/docs/"+strconv.FormatInt(baseEntry.ID, 10)+"/account-duplicate", map[string]any{}, guestHeader)
	guestCopyRes.Body.Close()
	if guestCopyRes.StatusCode != http.StatusForbidden {
		t.Fatalf("guest copy of locked-view base expected 403, got %d", guestCopyRes.StatusCode)
	}

	// 4. Copy doc and survey directly into targetFolder (verifies Postgres drive_revision=1 fence).
	docRes := postWith(owner, ts.URL+"/api/drive/nodes", map[string]any{"kind": "doc", "title": "设计规范", "scope": "personal"}, ownerHeader)
	if docRes.StatusCode != http.StatusCreated {
		t.Fatalf("create doc: %d", docRes.StatusCode)
	}
	var docEntry store.DriveEntry
	_ = json.NewDecoder(docRes.Body).Decode(&docEntry)
	docRes.Body.Close()

	dupDocRes := postWith(owner, ts.URL+"/api/docs/"+strconv.FormatInt(docEntry.ID, 10)+"/account-duplicate", map[string]any{
		"parentId": targetFolder.ID,
	}, ownerHeader)
	if dupDocRes.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(dupDocRes.Body)
		t.Fatalf("duplicate doc into folder: %d %s", dupDocRes.StatusCode, string(b))
	}
	var copiedDoc store.DocMeta
	_ = json.NewDecoder(dupDocRes.Body).Decode(&copiedDoc)
	dupDocRes.Body.Close()
	if copiedDoc.ParentID == nil || *copiedDoc.ParentID != targetFolder.ID {
		t.Fatalf("copied doc parent mismatch: %+v", copiedDoc)
	}

	svRes := postWith(owner, ts.URL+"/api/drive/nodes", map[string]any{"kind": "survey", "title": "季度问卷", "scope": "personal"}, ownerHeader)
	if svRes.StatusCode != http.StatusCreated {
		t.Fatalf("create survey: %d", svRes.StatusCode)
	}
	var svEntry store.DriveEntry
	_ = json.NewDecoder(svRes.Body).Decode(&svEntry)
	svRes.Body.Close()

	dupSvRes := postWith(owner, ts.URL+"/api/docs/"+strconv.FormatInt(svEntry.ID, 10)+"/account-duplicate", map[string]any{
		"parentId": targetFolder.ID,
	}, ownerHeader)
	if dupSvRes.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(dupSvRes.Body)
		t.Fatalf("duplicate survey into folder: %d %s", dupSvRes.StatusCode, string(b))
	}
	var copiedSv store.DocMeta
	_ = json.NewDecoder(dupSvRes.Body).Decode(&copiedSv)
	dupSvRes.Body.Close()
	if copiedSv.Kind != "survey" || copiedSv.ParentID == nil || *copiedSv.ParentID != targetFolder.ID {
		t.Fatalf("copied survey mismatch: %+v", copiedSv)
	}

	// 5. Drive shortcuts: create, list, live permission check on revoke/trash, and delete without deleting target.
	// Share docEntry with guest so guest can create a shortcut in their own personal root.
	if err := st.SetShare(ctx, docEntry.ID, guestUser.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	scCreateRes := postWith(guest, ts.URL+"/api/drive/shortcuts", map[string]any{
		"targetNodeId": docEntry.ID,
		"scope":        "personal",
	}, guestHeader)
	if scCreateRes.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(scCreateRes.Body)
		t.Fatalf("create shortcut: %d %s", scCreateRes.StatusCode, string(b))
	}
	var sc store.DriveShortcut
	_ = json.NewDecoder(scCreateRes.Body).Decode(&sc)
	scCreateRes.Body.Close()
	if !sc.TargetAccessible || sc.TargetKind != "doc" || sc.TargetTitle != "设计规范" {
		t.Fatalf("created shortcut enrichment mismatch: %+v", sc)
	}

	// Revoke guest share -> listing shortcut immediately marks targetAccessible=false and hides targetTitle!
	if err := st.SetShare(ctx, docEntry.ID, guestUser.ID, ""); err != nil {
		t.Fatal(err)
	}
	listRes, err := guest.Get(ts.URL + "/api/drive/shortcuts?scope=personal")
	if err != nil {
		t.Fatal(err)
	}
	var listOut struct {
		Shortcuts []store.DriveShortcut `json:"shortcuts"`
	}
	_ = json.NewDecoder(listRes.Body).Decode(&listOut)
	listRes.Body.Close()
	if len(listOut.Shortcuts) != 1 || listOut.Shortcuts[0].TargetAccessible || listOut.Shortcuts[0].TargetTitle != "" {
		t.Fatalf("revoked shortcut should hide target metadata: %+v", listOut.Shortcuts)
	}

	// Guest cannot create a shortcut to an inaccessible private node.
	unauthSc := postWith(guest, ts.URL+"/api/drive/shortcuts", map[string]any{
		"targetNodeId": copiedDoc.ID,
		"scope":        "personal",
	}, guestHeader)
	unauthSc.Body.Close()
	if unauthSc.StatusCode != http.StatusNotFound {
		t.Fatalf("unauthorized shortcut creation expected 404, got %d", unauthSc.StatusCode)
	}

	// Owner cannot delete guest's personal shortcut.
	unauthDel := delWith(owner, ts.URL+"/api/drive/shortcuts/"+strconv.FormatInt(sc.ID, 10), ownerHeader)
	unauthDel.Body.Close()
	if unauthDel.StatusCode != http.StatusForbidden {
		t.Fatalf("unauthorized shortcut delete expected 403, got %d", unauthDel.StatusCode)
	}

	// Guest deletes shortcut; original docEntry remains intact for owner.
	delRes := delWith(guest, ts.URL+"/api/drive/shortcuts/"+strconv.FormatInt(sc.ID, 10), guestHeader)
	delRes.Body.Close()
	if delRes.StatusCode != http.StatusNoContent {
		t.Fatalf("delete shortcut expected 204, got %d", delRes.StatusCode)
	}
	if _, err := st.GetDoc(ctx, ownerUser.ID, docEntry.ID); err != nil {
		t.Fatalf("original doc should remain intact after shortcut removal: %v", err)
	}
}

func bytesReader(b []byte) *sliceReader { return &sliceReader{b: b} }

type sliceReader struct {
	b []byte
	i int
}

func (r *sliceReader) Read(p []byte) (int, error) {
	if r.i >= len(r.b) {
		return 0, io.EOF
	}
	n := copy(p, r.b[r.i:])
	r.i += n
	return n, nil
}

func TestHomeDriveClosureMemory(t *testing.T) {
	runHomeDriveClosureSuite(t, store.NewMemory())
}

func TestHomeDriveClosurePostgres(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := pgx.Identifier{fmt.Sprintf("jiange_home_drive_%d", time.Now().UnixNano())}.Sanitize()
	defer func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+schema+" CASCADE")
		admin.Close()
	}()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	cfg.ConnConfig.RuntimeParams["application_name"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	runHomeDriveClosureSuite(t, &store.Postgres{Pool: pool})
}
