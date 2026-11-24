package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/ZSeven-W/jiange/server/internal/syncsrv"
)

func newAIWorkspaceTestServer(t *testing.T, mem *store.Memory, secret []byte) (*Server, *httptest.Server) {
	t.Helper()
	s := &Server{
		Store:        mem,
		Log:          slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL:   time.Hour,
		Iterations:   1000,
		AISecret:     secret,
		AIAllowHTTP:  true,
		PreviewAllow: func(ip netip.Addr) bool { return true },
	}
	baseHandler := s.Handler()
	mux := http.NewServeMux()
	mux.Handle("POST /api/ai/ask-workspace", s.requireUser(http.HandlerFunc(s.aiAskWorkspace)))
	mux.Handle("POST /api/ai/sheet-assist", s.requireUser(http.HandlerFunc(s.aiSheetAssist)))
	mux.Handle("POST /api/ai/base-fill", s.requireUser(http.HandlerFunc(s.aiBaseFill)))
	mux.Handle("/", baseHandler)
	wrapped := httpx.Chain(mux, httpx.WithRequestID, httpx.Recover(s.Log), httpx.RequireJSON)
	ts := httptest.NewServer(wrapped)
	t.Cleanup(ts.Close)
	return s, ts
}

func newTestClient() *http.Client {
	jar, _ := cookiejar.New(nil)
	return &http.Client{Jar: jar}
}

func appendDocBodyText(t *testing.T, st *store.Memory, docID int64, text string) {
	t.Helper()
	ctx := context.Background()
	state, _, err := StateAtHead(ctx, st, docID)
	if err != nil {
		t.Fatalf("StateAtHead(%d): %v", docID, err)
	}
	para := collab.OpID{Client: 0, Clock: 2}
	var raw []store.RawOp
	for i, r := range []rune(text) {
		op := state.InsertText(9, para, i, string(r))
		b, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatalf("EncodeOps: %v", err)
		}
		raw = append(raw, store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: b})
	}
	if _, err := st.AppendOps(ctx, docID, raw); err != nil {
		t.Fatalf("AppendOps: %v", err)
	}
}

func TestAIWorkspaceAuthRequired(t *testing.T) {
	mem := store.NewMemory()
	_, ts := newAIWorkspaceTestServer(t, mem, AISecretFromEnv("ws-ai-secret"))
	anon := newTestClient()

	for _, tc := range []struct {
		path string
		body any
	}{
		{"/api/ai/ask-workspace", map[string]any{"question": "hello"}},
		{"/api/ai/sheet-assist", map[string]any{"prompt": "求和"}},
		{"/api/ai/base-fill", map[string]any{"baseId": 1, "preset": "summarize", "rows": []map[string]any{{"recordId": 1, "text": "x"}}}},
	} {
		res := send(t, anon, http.MethodPost, ts.URL+tc.path, tc.body)
		res.Body.Close()
		if res.StatusCode != http.StatusUnauthorized {
			t.Fatalf("POST %s unauthenticated status=%d, want 401", tc.path, res.StatusCode)
		}
	}
}

func TestAIWorkspaceAskRAGPermissionsAndModes(t *testing.T) {
	var llmCapturedMessages []aiMessage
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}
		var payload struct {
			Messages []aiMessage `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&payload)
		llmCapturedMessages = payload.Messages
		w.Write([]byte(`{"choices":[{"message":{"content":"根据知识库文档，安全策略启用了 RBAC 与水印保护 [1]。"}}]}`))
	}))
	defer provider.Close()

	mem := store.NewMemory()
	_, ts := newAIWorkspaceTestServer(t, mem, AISecretFromEnv("ws-ai-rag-secret"))
	alice := newTestClient()
	bob := newTestClient()

	// Register Alice and Bob.
	var aliceMe struct {
		User       store.User        `json:"user"`
		Workspaces []store.Workspace `json:"workspaces"`
	}
	res := post(t, alice, ts.URL+"/api/auth/register", map[string]string{
		"email": "rag-alice@example.test", "name": "Alice", "password": "password123",
	})
	_ = json.NewDecoder(res.Body).Decode(&aliceMe)
	res.Body.Close()

	var bobMe struct {
		User       store.User        `json:"user"`
		Workspaces []store.Workspace `json:"workspaces"`
	}
	res = post(t, bob, ts.URL+"/api/auth/register", map[string]string{
		"email": "rag-bob@example.test", "name": "Bob", "password": "password123",
	})
	_ = json.NewDecoder(res.Body).Decode(&bobMe)
	res.Body.Close()

	ctx := context.Background()
	wsID := aliceMe.Workspaces[0].ID

	// Doc 1: Shared with Bob and copy-allowed.
	sharedDoc, err := mem.CreateDoc(ctx, wsID, aliceMe.User.ID, nil, "安全策略与权限规范", syncsrv.InitialOps("安全策略与权限规范"))
	if err != nil {
		t.Fatal(err)
	}
	appendDocBodyText(t, mem, sharedDoc.ID, "本空间全面启用 RBAC 角色权限、SSO 单点登录与全套件水印策略，核心安全审计日志保留 180 天。")
	if err := mem.SetShare(ctx, sharedDoc.ID, bobMe.User.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}

	// Doc 2: Private to Alice (NOT shared with Bob).
	privateDoc, err := mem.CreateDoc(ctx, wsID, aliceMe.User.ID, nil, "高管机密并购计划", syncsrv.InitialOps("高管机密并购计划"))
	if err != nil {
		t.Fatal(err)
	}
	appendDocBodyText(t, mem, privateDoc.ID, "代号 PROJECT-OMEGA-991 的保密预算为 5000 万，仅管理层可见。")

	// Doc 3: Shared with Bob as viewer, BUT copy-protected (copyMinRole = manage)!
	copyProtectedDoc, err := mem.CreateDoc(ctx, wsID, aliceMe.User.ID, nil, "受保护财务明细", syncsrv.InitialOps("受保护财务明细"))
	if err != nil {
		t.Fatal(err)
	}
	appendDocBodyText(t, mem, copyProtectedDoc.ID, "代号 SECRET-LEDGER-772 仅限在线查阅，禁止复制或发送给 AI。")
	if err := mem.SetShare(ctx, copyProtectedDoc.ID, bobMe.User.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if err := mem.SetCopyProtected(ctx, copyProtectedDoc.ID, true); err != nil {
		t.Fatal(err)
	}

	// 1) Bob queries shared content -> local RAG succeeds with citation to sharedDoc.
	res = send(t, bob, http.MethodPost, ts.URL+"/api/ai/ask-workspace", map[string]any{
		"question": "查找权限与安全策略",
	})
	var bobResp aiAskWorkspaceResp
	_ = json.NewDecoder(res.Body).Decode(&bobResp)
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("bob local ask status=%d", res.StatusCode)
	}
	if bobResp.Mode != "local" || bobResp.Model != "built-in-rag" {
		t.Fatalf("expected local built-in-rag, got mode=%q model=%q", bobResp.Mode, bobResp.Model)
	}
	if len(bobResp.Citations) != 1 || bobResp.Citations[0].DocID != sharedDoc.ID {
		t.Fatalf("expected only sharedDoc citation, got %+v", bobResp.Citations)
	}
	if !strings.Contains(bobResp.Answer, "[1]") || !strings.Contains(bobResp.Citations[0].Snippet, "RBAC") {
		t.Fatalf("expected grounded snippet & [1] citation, got resp=%+v", bobResp)
	}

	// 2) Bob queries Alice's private doc keyword -> 0 citations, zero leakage!
	res = send(t, bob, http.MethodPost, ts.URL+"/api/ai/ask-workspace", map[string]any{
		"question": "PROJECT-OMEGA-991 并购计划",
	})
	var privResp aiAskWorkspaceResp
	_ = json.NewDecoder(res.Body).Decode(&privResp)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || len(privResp.Citations) != 0 || strings.Contains(privResp.Answer, "5000") {
		t.Fatalf("private doc leaked to bob: status=%d resp=%+v", res.StatusCode, privResp)
	}

	// 3) Bob queries copy-protected doc keyword -> 0 citations, zero leakage!
	res = send(t, bob, http.MethodPost, ts.URL+"/api/ai/ask-workspace", map[string]any{
		"question": "SECRET-LEDGER-772 财务明细",
	})
	var cpResp aiAskWorkspaceResp
	_ = json.NewDecoder(res.Body).Decode(&cpResp)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || len(cpResp.Citations) != 0 || strings.Contains(cpResp.Answer, "在线查阅") {
		t.Fatalf("copy-protected doc leaked to viewer bob: status=%d resp=%+v", res.StatusCode, cpResp)
	}

	// 4) Alice (owner/manager) CAN retrieve her own copy-protected doc.
	res = send(t, alice, http.MethodPost, ts.URL+"/api/ai/ask-workspace", map[string]any{
		"question":    "SECRET-LEDGER-772",
		"workspaceId": wsID,
	})
	var aliceResp aiAskWorkspaceResp
	_ = json.NewDecoder(res.Body).Decode(&aliceResp)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || len(aliceResp.Citations) == 0 || aliceResp.Citations[0].DocID != copyProtectedDoc.ID {
		t.Fatalf("owner alice should retrieve own copy-protected doc: status=%d resp=%+v", res.StatusCode, aliceResp)
	}

	// 5) Bob configures LLM -> ask-workspace uses LLM path with grounded context + history.
	saveRes := send(t, bob, http.MethodPut, ts.URL+"/api/me/ai", map[string]string{
		"provider": "openai",
		"baseUrl":  provider.URL + "/v1",
		"model":    "gpt-4o-mini",
		"apiKey":   "sk-bob-test-998877",
	})
	saveRes.Body.Close()
	if saveRes.StatusCode != http.StatusOK {
		t.Fatalf("save bob AI settings status=%d", saveRes.StatusCode)
	}

	res = send(t, bob, http.MethodPost, ts.URL+"/api/ai/ask-workspace", map[string]any{
		"question": "安全策略包含哪些内容？",
		"history":  []map[string]string{{"role": "user", "content": "你好"}, {"role": "assistant", "content": "请问需要查找什么？"}},
	})
	var llmResp aiAskWorkspaceResp
	_ = json.NewDecoder(res.Body).Decode(&llmResp)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || llmResp.Mode != "llm" || llmResp.Model != "gpt-4o-mini" {
		t.Fatalf("expected llm response, got status=%d resp=%+v", res.StatusCode, llmResp)
	}
	if !strings.Contains(llmResp.Answer, "[1]") || len(llmResp.Citations) != 1 || llmResp.Citations[0].DocID != sharedDoc.ID {
		t.Fatalf("unexpected llm RAG output: %+v", llmResp)
	}
	if len(llmCapturedMessages) < 4 || !strings.Contains(llmCapturedMessages[0].Content, "安全策略与权限规范") || strings.Contains(llmCapturedMessages[0].Content, "SECRET-LEDGER-772") {
		t.Fatalf("LLM prompt missing grounded citation or leaked copy-restricted doc: %+v", llmCapturedMessages)
	}
}

func TestAIWorkspaceSheetAssistLocalAndLLM(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"choices":[{"message":{"content":"{\"answer\":\"按部门求销售额总和\",\"suggestedFormula\":\"=SUMIF(A2:A5, A2, D2:D5)\",\"explanation\":\"按 A 列部门汇总 D 列销售额\"}"}}]}`))
	}))
	defer provider.Close()

	mem := store.NewMemory()
	_, ts := newAIWorkspaceTestServer(t, mem, AISecretFromEnv("ws-ai-sheet-secret"))
	client := newTestClient()
	post(t, client, ts.URL+"/api/auth/register", map[string]string{
		"email": "sheet-ai@example.test", "name": "SheetUser", "password": "password123",
	}).Body.Close()

	headers := []string{"部门", "负责人", "邮箱", "销售额"}
	samples := [][]string{
		{"华东", "张三", "zhangsan@acme.cn", "1200"},
		{"华南", "李四", "lisi@acme.cn", "1800"},
		{"华东", "王五", "wangwu@acme.cn", "2400"},
		{"华北", "赵六", "zhaoliu@acme.cn", "600"},
	}

	casesToCheck := []struct {
		prompt      string
		wantFormula string
		wantNote    string
	}{
		{"按首列汇总数值", "=SUMIF(A2:A5, A2, D2:D5)", "6000"},
		{"计算销售额平均值", "=AVERAGE(D2:D5)", "1500"},
		{"筛选大于均值行", "=FILTER(A2:D5, D2:D5>AVERAGE(D2:D5))", "1500"},
		{"正则校验邮箱", "=REGEXMATCH(C2,", "REGEXMATCH"},
		{"按部门查找销售额 XLOOKUP", "=XLOOKUP(A2, A2:A5, D2:D5", "XLOOKUP"},
		{"去重部门列表 UNIQUE", "=UNIQUE(A2:A5)", "UNIQUE"},
		{"统计条件计数 COUNTIF", "=COUNTIF(A2:A5, A2)", "COUNTIF"},
		{"用 QUERY 分组查询", "=QUERY(A1:D5,", "QUERY"},
		{"使用 LET 变量计算", "=LET(", "LET"},
		{"求最高销售额 MAX", "=MAX(D2:D5)", "2400"},
		{"求最低销售额 MIN", "=MIN(D2:D5)", "600"},
	}

	for _, tc := range casesToCheck {
		res := send(t, client, http.MethodPost, ts.URL+"/api/ai/sheet-assist", map[string]any{
			"prompt":     tc.prompt,
			"headers":    headers,
			"sampleRows": samples,
			"activeCell": "E2",
			"sheetTitle": "Q3 销售表",
		})
		var out aiSheetAssistResp
		_ = json.NewDecoder(res.Body).Decode(&out)
		res.Body.Close()
		if res.StatusCode != http.StatusOK || out.Mode != "local" {
			t.Fatalf("prompt=%q status=%d out=%+v", tc.prompt, res.StatusCode, out)
		}
		if !strings.Contains(out.SuggestedFormula, tc.wantFormula) {
			t.Fatalf("prompt=%q got formula=%q, want substring %q", tc.prompt, out.SuggestedFormula, tc.wantFormula)
		}
		if !strings.Contains(out.Answer+out.Explanation, tc.wantNote) {
			t.Fatalf("prompt=%q missing expected note %q in answer=%q explanation=%q", tc.prompt, tc.wantNote, out.Answer, out.Explanation)
		}
	}

	// Configure LLM and verify mode == "llm".
	saveRes := send(t, client, http.MethodPut, ts.URL+"/api/me/ai", map[string]string{
		"provider": "openai",
		"baseUrl":  provider.URL + "/v1",
		"model":    "gpt-4o-mini",
		"apiKey":   "sk-sheet-12345678",
	})
	saveRes.Body.Close()
	res := send(t, client, http.MethodPost, ts.URL+"/api/ai/sheet-assist", map[string]any{
		"prompt":     "按部门汇总销售额",
		"headers":    headers,
		"sampleRows": samples,
		"activeCell": "E2",
	})
	var llmOut aiSheetAssistResp
	_ = json.NewDecoder(res.Body).Decode(&llmOut)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || llmOut.Mode != "llm" || llmOut.SuggestedFormula != "=SUMIF(A2:A5, A2, D2:D5)" {
		t.Fatalf("sheet LLM unexpected: status=%d out=%+v", res.StatusCode, llmOut)
	}
}

func TestAIWorkspaceBaseFillPermissionsLocalAndLLM(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"choices":[{"message":{"content":"[{\"recordId\":101,\"value\":\"高\"},{\"recordId\":102,\"value\":\"低\"}]"}}]}`))
	}))
	defer provider.Close()

	mem := store.NewMemory()
	_, ts := newAIWorkspaceTestServer(t, mem, AISecretFromEnv("ws-ai-base-secret"))
	owner := newTestClient()
	outsider := newTestClient()
	viewer := newTestClient()

	post(t, owner, ts.URL+"/api/auth/register", map[string]string{
		"email": "bf-owner@example.test", "name": "Owner", "password": "password123",
	}).Body.Close()
	post(t, outsider, ts.URL+"/api/auth/register", map[string]string{
		"email": "bf-outsider@example.test", "name": "Outsider", "password": "password123",
	}).Body.Close()
	var viewerMe struct{ User store.User }
	vRes := post(t, viewer, ts.URL+"/api/auth/register", map[string]string{
		"email": "bf-viewer@example.test", "name": "Viewer", "password": "password123",
	})
	_ = json.NewDecoder(vRes.Body).Decode(&viewerMe)
	vRes.Body.Close()

	var base store.DocMeta
	bRes := post(t, owner, ts.URL+"/api/bases", map[string]string{"title": "客户工单表"})
	_ = json.NewDecoder(bRes.Body).Decode(&base)
	bRes.Body.Close()

	rows := []map[string]any{
		{"recordId": 101, "text": "线上支付接口崩溃阻塞客户下单，需要紧急修复"},
		{"recordId": 102, "text": "后续有空时微调按钮配色，属于低优先级建议"},
	}

	// 1) Outsider cannot call base-fill on owner's base (404).
	res := send(t, outsider, http.MethodPost, ts.URL+"/api/ai/base-fill", map[string]any{
		"baseId":          base.ID,
		"preset":          "classify",
		"sourceFieldName": "工单描述",
		"targetFieldType": "select",
		"options":         []string{"高", "中", "低"},
		"rows":            rows,
	})
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("outsider base-fill status=%d, want 404", res.StatusCode)
	}

	// 2) Copy-protected base rejects viewer with 403 copy_restricted.
	ctx := context.Background()
	if err := mem.SetShare(ctx, base.ID, viewerMe.User.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if err := mem.SetCopyProtected(ctx, base.ID, true); err != nil {
		t.Fatal(err)
	}
	res = send(t, viewer, http.MethodPost, ts.URL+"/api/ai/base-fill", map[string]any{
		"baseId":          base.ID,
		"preset":          "summarize",
		"sourceFieldName": "工单描述",
		"targetFieldType": "text",
		"rows":            rows,
	})
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("copy-restricted viewer base-fill status=%d, want 403", res.StatusCode)
	}

	// 3) > 50 rows rejected with 400.
	tooMany := make([]map[string]any, 51)
	for i := range tooMany {
		tooMany[i] = map[string]any{"recordId": i + 1, "text": "行内容"}
	}
	res = send(t, owner, http.MethodPost, ts.URL+"/api/ai/base-fill", map[string]any{
		"baseId":          base.ID,
		"preset":          "summarize",
		"sourceFieldName": "工单描述",
		"targetFieldType": "text",
		"rows":            tooMany,
	})
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("over-50 rows status=%d, want 400", res.StatusCode)
	}

	// 4) Local classify maps rows strictly into provided options.
	res = send(t, owner, http.MethodPost, ts.URL+"/api/ai/base-fill", map[string]any{
		"baseId":          base.ID,
		"preset":          "classify",
		"sourceFieldName": "工单描述",
		"targetFieldType": "select",
		"options":         []string{"高", "中", "低"},
		"rows":            rows,
	})
	var clsOut aiBaseFillResp
	_ = json.NewDecoder(res.Body).Decode(&clsOut)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || clsOut.Mode != "local" || len(clsOut.Results) != 2 {
		t.Fatalf("local classify status=%d out=%+v", res.StatusCode, clsOut)
	}
	if clsOut.Results[0].Value != "高" || clsOut.Results[1].Value != "低" {
		t.Fatalf("unexpected local classification: %+v", clsOut.Results)
	}

	// 5) Local summarize, extract_keywords, translate_en, custom all succeed.
	for _, preset := range []string{"summarize", "extract_keywords", "translate_en", "custom"} {
		body := map[string]any{
			"baseId":          base.ID,
			"preset":          preset,
			"sourceFieldName": "工单描述",
			"targetFieldType": "text",
			"rows":            rows,
		}
		if preset == "custom" {
			body["customPrompt"] = "统计字数并精简"
		}
		r := send(t, owner, http.MethodPost, ts.URL+"/api/ai/base-fill", body)
		var out aiBaseFillResp
		_ = json.NewDecoder(r.Body).Decode(&out)
		r.Body.Close()
		if r.StatusCode != http.StatusOK || out.Mode != "local" || len(out.Results) != 2 || out.Results[0].Value == "" {
			t.Fatalf("preset=%q failed: status=%d out=%+v", preset, r.StatusCode, out)
		}
	}

	// 6) Configured LLM path returns mode="llm".
	saveRes := send(t, owner, http.MethodPut, ts.URL+"/api/me/ai", map[string]string{
		"provider": "openai",
		"baseUrl":  provider.URL + "/v1",
		"model":    "gpt-4o-mini",
		"apiKey":   "sk-base-98765432",
	})
	saveRes.Body.Close()
	res = send(t, owner, http.MethodPost, ts.URL+"/api/ai/base-fill", map[string]any{
		"baseId":          base.ID,
		"preset":          "classify",
		"sourceFieldName": "工单描述",
		"targetFieldType": "select",
		"options":         []string{"高", "中", "低"},
		"rows":            rows,
	})
	var llmOut aiBaseFillResp
	_ = json.NewDecoder(res.Body).Decode(&llmOut)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || llmOut.Mode != "llm" || len(llmOut.Results) != 2 || llmOut.Results[0].Value != "高" {
		t.Fatalf("base-fill LLM failed: status=%d out=%+v", res.StatusCode, llmOut)
	}
}
