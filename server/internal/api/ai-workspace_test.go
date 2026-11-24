package api

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/blob"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/ZSeven-W/jiange/server/internal/syncsrv"
)

func newAIWorkspaceTestServer(t *testing.T, mem *store.Memory, secret []byte) (*Server, *httptest.Server) {
	t.Helper()
	s := &Server{
		Store:        mem,
		Blobs:        blob.NewMemory(),
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
	mux.Handle("POST /api/ai/workspace-ask/stream", s.requireUser(http.HandlerFunc(s.aiWorkspaceAskStream)))
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
		{"/api/ai/workspace-ask/stream", map[string]any{"question": "hello"}},
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

type parsedSSEFrame struct {
	Event string
	Data  string
}

func readSSEFrames(t *testing.T, r io.Reader) []parsedSSEFrame {
	t.Helper()
	var frames []parsedSSEFrame
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64<<10), 1<<20)
	var curEvent string
	var dataLines []string
	flush := func() {
		if curEvent == "" && len(dataLines) == 0 {
			return
		}
		frames = append(frames, parsedSSEFrame{
			Event: curEvent,
			Data:  strings.Join(dataLines, "\n"),
		})
		curEvent = ""
		dataLines = nil
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			flush()
			continue
		}
		if strings.HasPrefix(line, "event:") {
			curEvent = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		} else if strings.HasPrefix(line, "data:") {
			dataLines = append(dataLines, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("readSSEFrames: %v", err)
	}
	flush()
	return frames
}

func TestAIWorkspaceHybridEmbeddingsAndAttachmentRAG(t *testing.T) {
	// 1. Unit checks on ComputeLocalEmbedding (128 dims, unit norm, semantic similarity).
	v1 := ComputeLocalEmbedding("Encrypting workspace documents and auditing compliance policies")
	v2 := ComputeLocalEmbedding("Encrypted document audit compliance policy")
	vDisjoint := ComputeLocalEmbedding("Banana smoothie recipe with strawberries and yogurt")
	if len(v1) != localEmbeddingDims || len(v2) != localEmbeddingDims {
		t.Fatalf("expected %d dims, got %d and %d", localEmbeddingDims, len(v1), len(v2))
	}
	var normSq float64
	for _, x := range v1 {
		normSq += float64(x) * float64(x)
	}
	if math.Abs(math.Sqrt(normSq)-1.0) > 1e-4 {
		t.Fatalf("expected unit L2 norm, got %f", math.Sqrt(normSq))
	}
	simRelated := cosineSimilarity(v1, v2)
	simDisjoint := cosineSimilarity(v1, vDisjoint)
	if simRelated < 0.45 || simRelated <= simDisjoint+0.25 {
		t.Fatalf("expected strong semantic similarity over disjoint text: related=%.4f disjoint=%.4f", simRelated, simDisjoint)
	}

	zhA := ComputeLocalEmbedding("企业级私有化部署与安全审计策略")
	zhB := ComputeLocalEmbedding("私有化部署安全审计规范")
	if c := cosineSimilarity(zhA, zhB); c < 0.40 {
		t.Fatalf("expected strong CJK semantic cosine similarity, got %.4f", c)
	}

	// 2. End-to-end hybrid retrieval + embedding persistence + attachment RAG.
	mem := store.NewMemory()
	_, ts := newAIWorkspaceTestServer(t, mem, AISecretFromEnv("ws-ai-hybrid-secret"))
	alice := newTestClient()

	var aliceMe struct {
		User       store.User        `json:"user"`
		Workspaces []store.Workspace `json:"workspaces"`
	}
	regRes := post(t, alice, ts.URL+"/api/auth/register", map[string]string{
		"email": "hybrid-alice@example.test", "name": "Alice", "password": "password123",
	})
	_ = json.NewDecoder(regRes.Body).Decode(&aliceMe)
	regRes.Body.Close()

	ctx := context.Background()
	wsID := aliceMe.Workspaces[0].ID

	// Create a regular doc using morphological variants ("encrypted", "deployments").
	secDoc, err := mem.CreateDoc(ctx, wsID, aliceMe.User.ID, nil, "Security Architecture", syncsrv.InitialOps("Security Architecture"))
	if err != nil {
		t.Fatal(err)
	}
	appendDocBodyText(t, mem, secDoc.ID, "All customer records are encrypted at rest and automated deployments verify cryptographic signatures.")

	// Upload a Drive FlateDecode PDF file with unique searchable knowledge.
	uploadFile := func(endpoint, filename string, data []byte) *http.Response {
		t.Helper()
		var body bytes.Buffer
		mw := multipart.NewWriter(&body)
		part, err := mw.CreateFormFile("file", filename)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = part.Write(data)
		_ = mw.Close()
		req, _ := http.NewRequest(http.MethodPost, ts.URL+endpoint, &body)
		req.Header.Set("Content-Type", mw.FormDataContentType())
		req.Header.Set("X-Jiange-Upload", "1")
		res, err := alice.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}

	pdfBytes := buildTestPDF(t, "BT /F1 12 Tf (Quarterly SLA uptime target is 99.995 percent for Helios Cluster) Tj ET", true)
	driveRes := uploadFile("/api/drive/files", "helios-sla.pdf", pdfBytes)
	var pdfNode store.DriveEntry
	_ = json.NewDecoder(driveRes.Body).Decode(&pdfNode)
	driveRes.Body.Close()
	if driveRes.StatusCode != http.StatusCreated {
		t.Fatalf("upload drive pdf status=%d", driveRes.StatusCode)
	}

	// Create a doc with a DOCX attachment containing distinct compliance clauses.
	parentDoc, err := mem.CreateDoc(ctx, wsID, aliceMe.User.ID, nil, "Vendor Onboarding", syncsrv.InitialOps("Vendor Onboarding"))
	if err != nil {
		t.Fatal(err)
	}
	docxBytes := buildTestDOCX(t, []string{"供应商准入要求：必须通过等保三级认证并签署数据零留存协议"})
	attRes := uploadFile("/api/docs/"+strconv.FormatInt(parentDoc.ID, 10)+"/files", "vendor-policy.docx", docxBytes)
	attRes.Body.Close()
	if attRes.StatusCode != http.StatusCreated {
		t.Fatalf("upload doc docx status=%d", attRes.StatusCode)
	}

	// Query 1: hit content inside uploaded Drive PDF.
	res := send(t, alice, http.MethodPost, ts.URL+"/api/ai/ask-workspace", map[string]any{
		"question": "What is the Helios Cluster SLA uptime target?",
	})
	var pdfAsk aiAskWorkspaceResp
	_ = json.NewDecoder(res.Body).Decode(&pdfAsk)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || pdfAsk.Retrieval != "hybrid" {
		t.Fatalf("drive pdf ask failed: status=%d resp=%+v", res.StatusCode, pdfAsk)
	}
	if len(pdfAsk.Citations) == 0 || pdfAsk.Citations[0].DocID != pdfNode.ID || pdfAsk.Citations[0].Kind != "file" {
		t.Fatalf("expected Drive PDF citation first, got %+v", pdfAsk.Citations)
	}
	if !strings.Contains(pdfAsk.Citations[0].Snippet, "99.995") {
		t.Fatalf("expected PDF snippet in citation, got %+v", pdfAsk.Citations[0])
	}

	// Verify doc_embeddings were persisted for all accessible candidates!
	embs, err := mem.GetDocEmbeddings(ctx, []int64{secDoc.ID, pdfNode.ID, parentDoc.ID})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []int64{secDoc.ID, pdfNode.ID, parentDoc.ID} {
		e, ok := embs[id]
		if !ok || e.Model != localEmbeddingModel || e.Dimensions != localEmbeddingDims || e.ContentHash == "" || len(e.Vector) != localEmbeddingDims {
			t.Fatalf("missing or invalid persisted embedding for doc %d: %+v", id, e)
		}
	}

	// Query 2: hit content inside the DOCX attachment attached to parentDoc.
	res = send(t, alice, http.MethodPost, ts.URL+"/api/ai/ask-workspace", map[string]any{
		"question": "供应商准入需要通过什么安全认证和协议？",
	})
	var docxAsk aiAskWorkspaceResp
	_ = json.NewDecoder(res.Body).Decode(&docxAsk)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || len(docxAsk.Citations) == 0 || docxAsk.Citations[0].DocID != parentDoc.ID {
		t.Fatalf("expected parentDoc citation from DOCX attachment, got status=%d resp=%+v", res.StatusCode, docxAsk)
	}
	if !strings.Contains(docxAsk.Citations[0].Snippet, "等保三级") {
		t.Fatalf("expected DOCX attachment snippet, got %+v", docxAsk.Citations[0])
	}

	// Query 3: semantic / morphological English retrieval ("encrypting" / "deploying" matching "encrypted" / "deployments").
	res = send(t, alice, http.MethodPost, ts.URL+"/api/ai/ask-workspace", map[string]any{
		"question": "encrypting customer records and deploying cryptographic verification",
	})
	var semAsk aiAskWorkspaceResp
	_ = json.NewDecoder(res.Body).Decode(&semAsk)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || len(semAsk.Citations) == 0 || semAsk.Citations[0].DocID != secDoc.ID {
		t.Fatalf("expected semantic hit on secDoc, got status=%d resp=%+v", res.StatusCode, semAsk)
	}

	// Query 4: remote OpenAI /v1/embeddings endpoint is used when available and stored in doc_embeddings.
	remoteEmbCalled := false
	embProvider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/embeddings":
			remoteEmbCalled = true
			var in struct {
				Model string   `json:"model"`
				Input []string `json:"input"`
			}
			_ = json.NewDecoder(r.Body).Decode(&in)
			data := make([]map[string]any, len(in.Input))
			for i, txt := range in.Input {
				// Give secDoc + query identical unit vector [1, 0, 0, 0], others [0, 1, 0, 0].
				vec := []float32{0, 1, 0, 0}
				if i == 0 || strings.Contains(txt, "Security Architecture") {
					vec = []float32{1, 0, 0, 0}
				}
				data[i] = map[string]any{"index": i, "embedding": vec}
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"data": data})
		case "/v1/chat/completions":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"Remote embedding grounded answer [1]."}}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer embProvider.Close()

	saveRes := send(t, alice, http.MethodPut, ts.URL+"/api/me/ai", map[string]string{
		"provider": "openai",
		"baseUrl":  embProvider.URL + "/v1",
		"model":    "gpt-4o-mini",
		"apiKey":   "sk-remote-emb-test-1234",
	})
	saveRes.Body.Close()

	res = send(t, alice, http.MethodPost, ts.URL+"/api/ai/ask-workspace", map[string]any{
		"question": "zero-overlap query routed purely via remote embedding",
	})
	var remoteAsk aiAskWorkspaceResp
	_ = json.NewDecoder(res.Body).Decode(&remoteAsk)
	res.Body.Close()
	if !remoteEmbCalled {
		t.Fatal("expected remote /v1/embeddings to be invoked")
	}
	if res.StatusCode != http.StatusOK || len(remoteAsk.Citations) == 0 || remoteAsk.Citations[0].DocID != secDoc.ID {
		t.Fatalf("expected remote embedding vector match on secDoc, got status=%d resp=%+v", res.StatusCode, remoteAsk)
	}
	embsAfter, err := mem.GetDocEmbeddings(ctx, []int64{secDoc.ID})
	if err != nil || embsAfter[secDoc.ID].Model != aiDefaultEmbeddingModel || embsAfter[secDoc.ID].Dimensions != 4 {
		t.Fatalf("expected remote embedding persisted with model=%q dims=4, got %+v err=%v", aiDefaultEmbeddingModel, embsAfter[secDoc.ID], err)
	}
}

func TestAIWorkspaceAskStreamSSELocalAndOpenAI(t *testing.T) {
	var upstreamSawStream bool
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}
		var payload struct {
			Stream bool `json:"stream"`
		}
		_ = json.NewDecoder(r.Body).Decode(&payload)
		upstreamSawStream = payload.Stream
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		flusher, _ := w.(http.Flusher)
		chunks := []string{"根据检索结果，", "系统已启用 ", "混合向量检索", " 与流式输出 [1]。"}
		for _, tok := range chunks {
			b, _ := json.Marshal(map[string]any{
				"choices": []map[string]any{{"delta": map[string]string{"content": tok}}},
			})
			fmt.Fprintf(w, "data: %s\n\n", b)
			if flusher != nil {
				flusher.Flush()
			}
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
		if flusher != nil {
			flusher.Flush()
		}
	}))
	defer provider.Close()

	mem := store.NewMemory()
	_, ts := newAIWorkspaceTestServer(t, mem, AISecretFromEnv("ws-ai-stream-secret"))
	client := newTestClient()

	var me struct {
		User       store.User        `json:"user"`
		Workspaces []store.Workspace `json:"workspaces"`
	}
	regRes := post(t, client, ts.URL+"/api/auth/register", map[string]string{
		"email": "stream-user@example.test", "name": "StreamUser", "password": "password123",
	})
	_ = json.NewDecoder(regRes.Body).Decode(&me)
	regRes.Body.Close()

	ctx := context.Background()
	doc, err := mem.CreateDoc(ctx, me.Workspaces[0].ID, me.User.ID, nil, "流式知识检索设计", syncsrv.InitialOps("流式知识检索设计"))
	if err != nil {
		t.Fatal(err)
	}
	appendDocBodyText(t, mem, doc.ID, "本系统支持 128 维语义向量混合检索、附件全文提取与 SSE 实时流式输出。")

	// 1. Local extractive SSE mode (no API key configured).
	res := send(t, client, http.MethodPost, ts.URL+"/api/ai/workspace-ask/stream", map[string]any{
		"question": "介绍混合检索与流式输出能力",
	})
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("local stream status=%d", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("expected text/event-stream content-type, got %q", ct)
	}
	localFrames := readSSEFrames(t, res.Body)
	if len(localFrames) < 3 {
		t.Fatalf("expected citations + delta(s) + done frames, got %d: %+v", len(localFrames), localFrames)
	}
	if localFrames[0].Event != "citations" {
		t.Fatalf("first SSE event=%q, want citations", localFrames[0].Event)
	}
	var localCitEvent struct {
		Citations []aiWorkspaceCitation `json:"citations"`
		Mode      string                `json:"mode"`
		Model     string                `json:"model"`
		Retrieval string                `json:"retrieval"`
	}
	if err := json.Unmarshal([]byte(localFrames[0].Data), &localCitEvent); err != nil {
		t.Fatalf("decode local citations event: %v", err)
	}
	if localCitEvent.Mode != "local" || localCitEvent.Retrieval != "hybrid" || len(localCitEvent.Citations) != 1 || localCitEvent.Citations[0].DocID != doc.ID {
		t.Fatalf("unexpected local citations event: %+v", localCitEvent)
	}
	var localJoined strings.Builder
	deltaCount := 0
	for _, f := range localFrames[1 : len(localFrames)-1] {
		if f.Event != "delta" {
			t.Fatalf("expected delta event, got %q", f.Event)
		}
		var d struct {
			Text string `json:"text"`
		}
		if err := json.Unmarshal([]byte(f.Data), &d); err != nil {
			t.Fatalf("decode delta: %v", err)
		}
		localJoined.WriteString(d.Text)
		deltaCount++
	}
	if deltaCount == 0 {
		t.Fatal("expected at least one local delta event")
	}
	lastLocal := localFrames[len(localFrames)-1]
	if lastLocal.Event != "done" {
		t.Fatalf("last SSE event=%q, want done", lastLocal.Event)
	}
	var localDone aiAskWorkspaceResp
	if err := json.Unmarshal([]byte(lastLocal.Data), &localDone); err != nil {
		t.Fatalf("decode done event: %v", err)
	}
	if localDone.Answer != strings.TrimSpace(localJoined.String()) || localDone.Mode != "local" || localDone.Retrieval != "hybrid" {
		t.Fatalf("local done mismatch: done=%+v joined=%q", localDone, localJoined.String())
	}

	// 2. Mock OpenAI streaming upstream mode.
	saveRes := send(t, client, http.MethodPut, ts.URL+"/api/me/ai", map[string]string{
		"provider": "openai",
		"baseUrl":  provider.URL + "/v1",
		"model":    "gpt-4o-mini",
		"apiKey":   "sk-stream-test-998877",
	})
	saveRes.Body.Close()
	if saveRes.StatusCode != http.StatusOK {
		t.Fatalf("save AI settings status=%d", saveRes.StatusCode)
	}

	res2 := send(t, client, http.MethodPost, ts.URL+"/api/ai/workspace-ask/stream", map[string]any{
		"question": "系统如何实现混合向量检索？",
	})
	defer res2.Body.Close()
	if res2.StatusCode != http.StatusOK {
		t.Fatalf("openai stream status=%d", res2.StatusCode)
	}
	llmFrames := readSSEFrames(t, res2.Body)
	if !upstreamSawStream {
		t.Fatal("expected upstream OpenAI request to set stream=true")
	}
	if len(llmFrames) != 6 { // 1 citations + 4 deltas + 1 done
		t.Fatalf("expected 6 SSE frames (citations + 4 deltas + done), got %d: %+v", len(llmFrames), llmFrames)
	}
	if llmFrames[0].Event != "citations" || llmFrames[5].Event != "done" {
		t.Fatalf("unexpected frame envelope: first=%q last=%q", llmFrames[0].Event, llmFrames[5].Event)
	}
	var llmJoined strings.Builder
	for _, f := range llmFrames[1:5] {
		if f.Event != "delta" {
			t.Fatalf("expected delta frame, got %q", f.Event)
		}
		var d struct {
			Text string `json:"text"`
		}
		_ = json.Unmarshal([]byte(f.Data), &d)
		llmJoined.WriteString(d.Text)
	}
	var llmDone aiAskWorkspaceResp
	_ = json.Unmarshal([]byte(llmFrames[5].Data), &llmDone)
	wantAnswer := "根据检索结果，系统已启用 混合向量检索 与流式输出 [1]。"
	if llmJoined.String() != wantAnswer || llmDone.Answer != wantAnswer || llmDone.Mode != "llm" || llmDone.Model != "gpt-4o-mini" || llmDone.Retrieval != "hybrid" {
		t.Fatalf("unexpected OpenAI streaming result: joined=%q done=%+v", llmJoined.String(), llmDone)
	}
}
