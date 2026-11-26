package api

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"math"
	"net/http"
	"os"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/auth"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"golang.org/x/text/cases"
)

const (
	aiWorkspaceMaxCandidates    = 400
	aiWorkspaceMaxCitations     = 6
	aiWorkspaceMaxQuestion      = 2000
	aiWorkspaceMaxHistory       = 8
	aiSheetMaxHeaders           = 64
	aiSheetMaxSampleRows        = 50
	aiBaseFillMaxRows           = 50
	aiBaseFillBatchSize         = 25
	localEmbeddingDims          = 128
	localEmbeddingModel         = "local-ngram-v1"
	aiDefaultEmbeddingModel     = "text-embedding-3-small"
	aiRemoteEmbeddingBatchLimit = 32
	aiSemanticOnlyThreshold     = 0.28
)

type aiWorkspaceCitation struct {
	DocID       int64   `json:"docId"`
	Title       string  `json:"title"`
	Kind        string  `json:"kind"`
	WikiSpaceID *int64  `json:"wikiSpaceId,omitempty"`
	Snippet     string  `json:"snippet"`
	Score       float64 `json:"score"`
}

type aiAskWorkspaceReq struct {
	Question    string      `json:"question"`
	WorkspaceID int64       `json:"workspaceId"`
	WikiSpaceID int64       `json:"wikiSpaceId"`
	History     []aiMessage `json:"history"`
}

type aiAskWorkspaceResp struct {
	Answer    string                `json:"answer"`
	Citations []aiWorkspaceCitation `json:"citations"`
	Mode      string                `json:"mode"`
	Model     string                `json:"model"`
	Retrieval string                `json:"retrieval,omitempty"`
}

type aiSheetAssistReq struct {
	Prompt     string     `json:"prompt"`
	Headers    []string   `json:"headers"`
	SampleRows [][]string `json:"sampleRows"`
	ActiveCell string     `json:"activeCell"`
	SheetTitle string     `json:"sheetTitle"`
}

type aiSheetAssistResp struct {
	Answer           string `json:"answer"`
	SuggestedFormula string `json:"suggestedFormula,omitempty"`
	Explanation      string `json:"explanation"`
	Mode             string `json:"mode"`
}

type aiBaseFillRow struct {
	RecordID int64  `json:"recordId"`
	Text     string `json:"text"`
}

type aiBaseFillReq struct {
	BaseID          int64           `json:"baseId"`
	Preset          string          `json:"preset"`
	CustomPrompt    string          `json:"customPrompt"`
	SourceFieldName string          `json:"sourceFieldName"`
	TargetFieldType string          `json:"targetFieldType"`
	Options         []string        `json:"options"`
	Rows            []aiBaseFillRow `json:"rows"`
}

type aiBaseFillResult struct {
	RecordID int64  `json:"recordId"`
	Value    string `json:"value"`
}

type aiBaseFillResp struct {
	Results []aiBaseFillResult `json:"results"`
	Mode    string             `json:"mode"`
}

// configuredAIModel returns the user's saved model name if personal AI is usable.
func (s *Server) configuredAIModel(ctx context.Context, userID int64) (string, bool) {
	if len(s.AISecret) != 32 {
		return "", false
	}
	cur, err := s.Store.AISettings(ctx, userID)
	if err != nil {
		return "", false
	}
	model := strings.TrimSpace(cur.Model)
	if model == "" {
		_, model = aiDefaults(cur.Provider)
	}
	return model, true
}

func isBlockedAIError(err error) bool {
	var pe aiProviderError
	return errors.As(err, &pe) && pe.code == "ai_blocked_address"
}

func truncateRunes(s string, max int) string {
	if max <= 0 {
		return ""
	}
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	runes := []rune(s)
	return string(runes[:max])
}

func isLikelyEnglish(s string) bool {
	latin, cjk := 0, 0
	for _, r := range s {
		if unicode.Is(unicode.Han, r) {
			cjk++
		} else if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
			latin++
		}
	}
	return latin > 0 && cjk == 0
}

// --- 1. Workspace AI Knowledge Base Q&A (Hybrid Vector RAG + SSE Streaming) ---

func (s *Server) parseWorkspaceAskRequest(w http.ResponseWriter, r *http.Request) (store.User, string, []aiMessage, aiAskWorkspaceReq, bool) {
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "login required")
		return store.User{}, "", nil, aiAskWorkspaceReq{}, false
	}
	var in aiAskWorkspaceReq
	if !httpx.Decode(w, r, &in) {
		return store.User{}, "", nil, aiAskWorkspaceReq{}, false
	}
	question := strings.TrimSpace(in.Question)
	if question == "" || utf8.RuneCountInString(question) > aiWorkspaceMaxQuestion {
		httpx.Error(w, http.StatusBadRequest, "invalid_question", "请输入 1-2000 字的问题")
		return store.User{}, "", nil, aiAskWorkspaceReq{}, false
	}
	history := make([]aiMessage, 0, min(len(in.History), aiWorkspaceMaxHistory))
	startHist := 0
	if len(in.History) > aiWorkspaceMaxHistory {
		startHist = len(in.History) - aiWorkspaceMaxHistory
	}
	for _, m := range in.History[startHist:] {
		if m.Role != "user" && m.Role != "assistant" {
			httpx.Error(w, http.StatusBadRequest, "invalid_messages", "历史消息角色无效")
			return store.User{}, "", nil, aiAskWorkspaceReq{}, false
		}
		c := strings.TrimSpace(truncateRunes(m.Content, 1500))
		if c != "" {
			history = append(history, aiMessage{Role: m.Role, Content: c})
		}
	}
	if !s.aiRate.allow(u.ID, s.now()) {
		httpx.Error(w, http.StatusTooManyRequests, "ai_rate_limited", "请求过于频繁，请稍后再试")
		return store.User{}, "", nil, aiAskWorkspaceReq{}, false
	}
	return u, question, history, in, true
}

func (s *Server) aiAskWorkspace(w http.ResponseWriter, r *http.Request) {
	u, question, history, in, ok := s.parseWorkspaceAskRequest(w, r)
	if !ok {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	citations, err := s.retrieveWorkspaceCitations(ctx, r, u.ID, question, in.WorkspaceID, in.WikiSpaceID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if citations == nil {
		citations = []aiWorkspaceCitation{}
	}

	w.Header().Set("Cache-Control", "no-store")
	if model, ready := s.configuredAIModel(r.Context(), u.ID); ready {
		messages := buildWorkspaceRAGMessages(question, history, citations)
		text, aiErr := s.callAI(r.Context(), u.ID, messages)
		if aiErr == nil && strings.TrimSpace(text) != "" {
			httpx.JSON(w, http.StatusOK, aiAskWorkspaceResp{
				Answer:    strings.TrimSpace(text),
				Citations: citations,
				Mode:      "llm",
				Model:     model,
				Retrieval: "hybrid",
			})
			return
		}
		if isBlockedAIError(aiErr) {
			s.aiError(w, r, aiErr)
			return
		}
	}

	answer := synthesizeLocalRAGAnswer(question, citations)
	httpx.JSON(w, http.StatusOK, aiAskWorkspaceResp{
		Answer:    answer,
		Citations: citations,
		Mode:      "local",
		Model:     "built-in-rag",
		Retrieval: "hybrid",
	})
}

func writeSSEEvent(w http.ResponseWriter, rc *http.ResponseController, event string, payload any) error {
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, b); err != nil {
		return err
	}
	_ = rc.Flush()
	return nil
}

func streamTextChunks(ctx context.Context, text string, chunkRunes int, onDelta func(string) error) error {
	if text == "" {
		return nil
	}
	if chunkRunes <= 0 {
		chunkRunes = 24
	}
	runes := []rune(text)
	for start := 0; start < len(runes); {
		if err := ctx.Err(); err != nil {
			return err
		}
		end := min(start+chunkRunes, len(runes))
		// Prefer splitting right after a newline or space when close to boundary.
		if end < len(runes) {
			for look := end; look > start+chunkRunes/2; look-- {
				if runes[look-1] == '\n' || runes[look-1] == ' ' || runes[look-1] == '。' || runes[look-1] == '，' {
					end = look
					break
				}
			}
		}
		if err := onDelta(string(runes[start:end])); err != nil {
			return err
		}
		start = end
	}
	return nil
}

// aiWorkspaceAskStream streams citations immediately followed by live token deltas
// over Server-Sent Events (POST /api/ai/workspace-ask/stream).
func (s *Server) aiWorkspaceAskStream(w http.ResponseWriter, r *http.Request) {
	u, question, history, in, ok := s.parseWorkspaceAskRequest(w, r)
	if !ok {
		return
	}

	retrieveCtx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	citations, err := s.retrieveWorkspaceCitations(retrieveCtx, r, u.ID, question, in.WorkspaceID, in.WikiSpaceID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if citations == nil {
		citations = []aiWorkspaceCitation{}
	}

	model, ready := s.configuredAIModel(r.Context(), u.ID)
	mode := "local"
	modelName := "built-in-rag"
	if ready {
		mode = "llm"
		modelName = model
	}

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	rc := http.NewResponseController(w)
	if err := writeSSEEvent(w, rc, "citations", map[string]any{
		"citations": citations,
		"mode":      mode,
		"model":     modelName,
		"retrieval": "hybrid",
	}); err != nil {
		return
	}

	var answerBuf strings.Builder
	emitDelta := func(chunk string) error {
		if chunk == "" {
			return nil
		}
		answerBuf.WriteString(chunk)
		return writeSSEEvent(w, rc, "delta", map[string]string{"text": chunk})
	}

	if ready {
		messages := buildWorkspaceRAGMessages(question, history, citations)
		streamed, aiErr := s.streamAI(r.Context(), u.ID, messages, emitDelta)
		if aiErr != nil {
			if isBlockedAIError(aiErr) {
				var pe aiProviderError
				msg := aiErr.Error()
				code := "ai_blocked_address"
				if errors.As(aiErr, &pe) {
					code = pe.code
					msg = pe.message
				}
				_ = writeSSEEvent(w, rc, "error", map[string]string{"error": code, "message": msg})
				return
			}
			// If upstream rejected streaming before emitting tokens, try non-streaming LLM fallback.
			if !streamed {
				text, callErr := s.callAI(r.Context(), u.ID, messages)
				if callErr == nil && strings.TrimSpace(text) != "" {
					if err := streamTextChunks(r.Context(), strings.TrimSpace(text), 24, emitDelta); err != nil {
						return
					}
					streamed = true
				} else if isBlockedAIError(callErr) {
					var pe aiProviderError
					code, msg := "ai_blocked_address", callErr.Error()
					if errors.As(callErr, &pe) {
						code, msg = pe.code, pe.message
					}
					_ = writeSSEEvent(w, rc, "error", map[string]string{"error": code, "message": msg})
					return
				}
			}
		}
		if !streamed {
			mode = "local"
			modelName = "built-in-rag"
			fallback := synthesizeLocalRAGAnswer(question, citations)
			if err := streamTextChunks(r.Context(), fallback, 24, emitDelta); err != nil {
				return
			}
		}
	} else {
		answer := synthesizeLocalRAGAnswer(question, citations)
		if err := streamTextChunks(r.Context(), answer, 24, emitDelta); err != nil {
			return
		}
	}

	_ = writeSSEEvent(w, rc, "done", aiAskWorkspaceResp{
		Answer:    strings.TrimSpace(answerBuf.String()),
		Citations: citations,
		Mode:      mode,
		Model:     modelName,
		Retrieval: "hybrid",
	})
}

// streamAI invokes the user's configured OpenAI-compatible or Anthropic provider
// with stream=true and forwards incremental text tokens via onDelta.
// It returns emitted=true if at least one text delta was forwarded.
func (s *Server) streamAI(ctx context.Context, userID int64, messages []aiMessage, onDelta func(string) error) (bool, error) {
	cur, err := s.Store.AISettings(ctx, userID)
	if errors.Is(err, store.ErrNotFound) {
		return false, errAINotConfigured
	}
	if err != nil {
		return false, err
	}
	if len(s.AISecret) != 32 {
		return false, aiProviderError{http.StatusServiceUnavailable, "ai_secret_missing", "服务器未配置 JIANGE_SECRET_KEY，无法读取已保存的 API Key"}
	}
	key, err := openAIKey(s.AISecret, userID, cur.APIKeyCipher)
	if err != nil {
		return false, aiProviderError{http.StatusConflict, "ai_key_unreadable", "已保存的 API Key 无法解密，请在 AI 设置中重新填写"}
	}
	provider, _ := normalizeProvider(cur.Provider)
	base, ok := s.normalizeAIBase(cur.BaseURL, provider)
	if !ok {
		return false, aiProviderError{http.StatusBadRequest, "invalid_base_url", "接口地址无效，请在 AI 设置中修改"}
	}

	var req *http.Request
	if provider == "anthropic" {
		req, err = anthropicStreamRequest(ctx, base, key, cur.Model, messages)
	} else {
		body, _ := json.Marshal(map[string]any{
			"model":       cur.Model,
			"messages":    messages,
			"max_tokens":  2048,
			"temperature": 0.3,
			"stream":      true,
		})
		req, err = http.NewRequestWithContext(ctx, http.MethodPost, base+"/chat/completions", bytes.NewReader(body))
		if err == nil {
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Accept", "text/event-stream")
			req.Header.Set("Authorization", "Bearer "+key)
		}
	}
	if err != nil {
		return false, err
	}

	res, err := s.aiClient().Do(req)
	if err != nil {
		if errors.Is(err, errBlockedAddress) || strings.Contains(err.Error(), errBlockedAddress.Error()) {
			return false, aiProviderError{http.StatusBadRequest, "ai_blocked_address", "接口地址指向内网或保留地址，已拒绝"}
		}
		return false, aiProviderError{http.StatusBadGateway, "ai_unreachable", "无法连接 AI 服务，请检查接口地址或稍后重试"}
	}
	defer res.Body.Close()

	if res.StatusCode >= 300 {
		return false, aiProviderError{http.StatusBadGateway, "ai_failed", fmt.Sprintf("AI 服务返回错误（HTTP %d）", res.StatusCode)}
	}

	// Some OpenAI-compatible proxies ignore stream=true and return a plain JSON response.
	ct := strings.ToLower(res.Header.Get("Content-Type"))
	if strings.Contains(ct, "application/json") {
		raw, readErr := io.ReadAll(io.LimitReader(res.Body, aiMaxResponse+1))
		if readErr != nil || len(raw) > aiMaxResponse {
			return false, aiProviderError{http.StatusBadGateway, "ai_bad_response", "AI 服务响应过大或中断"}
		}
		var text string
		if provider == "anthropic" {
			text, err = parseAnthropic(raw)
		} else {
			var out struct {
				Choices []struct {
					Message struct {
						Content string `json:"content"`
					} `json:"message"`
				} `json:"choices"`
			}
			if json.Unmarshal(raw, &out) == nil && len(out.Choices) > 0 {
				text = strings.TrimSpace(out.Choices[0].Message.Content)
			} else {
				err = aiProviderError{http.StatusBadGateway, "ai_bad_response", "AI 服务返回了无法识别的结果"}
			}
		}
		if err != nil || text == "" {
			return false, err
		}
		if err := streamTextChunks(ctx, text, 24, onDelta); err != nil {
			return true, err
		}
		return true, nil
	}

	scanner := bufio.NewScanner(res.Body)
	scanner.Buffer(make([]byte, 0, 64<<10), 1<<20)
	emitted := false

	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return emitted, err
		}
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, ":") || !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || payload == "[DONE]" {
			if payload == "[DONE]" {
				break
			}
			continue
		}

		if provider == "anthropic" {
			var ev struct {
				Type  string `json:"type"`
				Delta struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"delta"`
			}
			if json.Unmarshal([]byte(payload), &ev) != nil {
				continue
			}
			if ev.Type == "message_stop" {
				break
			}
			if ev.Type == "content_block_delta" && ev.Delta.Type == "text_delta" && ev.Delta.Text != "" {
				emitted = true
				if err := onDelta(ev.Delta.Text); err != nil {
					return emitted, err
				}
			}
			continue
		}

		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
			} `json:"choices"`
		}
		if json.Unmarshal([]byte(payload), &chunk) != nil || len(chunk.Choices) == 0 {
			continue
		}
		tok := chunk.Choices[0].Delta.Content
		if tok == "" {
			tok = chunk.Choices[0].Message.Content
		}
		if tok != "" {
			emitted = true
			if err := onDelta(tok); err != nil {
				return emitted, err
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return emitted, err
	}
	if !emitted {
		return false, aiProviderError{http.StatusBadGateway, "ai_bad_response", "AI 流式响应未返回文本内容"}
	}
	return true, nil
}

func anthropicStreamRequest(ctx context.Context, base, key, model string, messages []aiMessage) (*http.Request, error) {
	var system []string
	turns := []aiMessage{}
	for _, m := range messages {
		if m.Role == "system" {
			system = append(system, m.Content)
			continue
		}
		if n := len(turns); n > 0 && turns[n-1].Role == m.Role {
			turns[n-1].Content += "\n\n" + m.Content
			continue
		}
		turns = append(turns, m)
	}
	if len(turns) == 0 || turns[0].Role != "user" {
		turns = append([]aiMessage{{Role: "user", Content: "（开始）"}}, turns...)
	}
	payload := map[string]any{
		"model":       model,
		"max_tokens":  2048,
		"temperature": 0.3,
		"messages":    turns,
		"stream":      true,
	}
	if len(system) > 0 {
		payload["system"] = strings.Join(system, "\n\n")
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/messages", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("x-api-key", key)
	req.Header.Set("anthropic-version", aiAnthropicVersion)
	return req, nil
}

// --- Hybrid Dense Semantic Embeddings (128-dim Local Feature Hashing + Optional OpenAI /embeddings) ---

func stemSimpleEnglish(word string) string {
	for _, suf := range []string{"ations", "ation", "ments", "ment", "ities", "ingly", "edly", "ness", "ings", "ing", "ies", "ied", "ers", "ed", "es", "ly", "s"} {
		if strings.HasSuffix(word, suf) && len(word)-len(suf) >= 3 {
			stem := word[:len(word)-len(suf)]
			if suf == "ies" || suf == "ied" {
				stem += "y"
			}
			return stem
		}
	}
	return word
}

// ComputeLocalEmbedding encodes text into a deterministic 128-dimension
// L2-normalized dense semantic vector using signed feature hashing over CJK
// unigrams/bigrams/trigrams and Unicode word stems/character trigrams.
func ComputeLocalEmbedding(text string) []float32 {
	vec := make([]float32, localEmbeddingDims)
	folded := cases.Fold().String(strings.TrimSpace(text))
	if folded == "" {
		return vec
	}

	type featWeight struct {
		base  float64
		count int
	}
	feats := make(map[string]*featWeight, 64)
	addFeat := func(key string, weight float64) {
		if fw, ok := feats[key]; ok {
			fw.count++
			if weight > fw.base {
				fw.base = weight
			}
			return
		}
		feats[key] = &featWeight{base: weight, count: 1}
	}

	var wordBuf strings.Builder
	var cjkBuf []rune

	flushWord := func() {
		if wordBuf.Len() == 0 {
			return
		}
		w := wordBuf.String()
		wordBuf.Reset()
		if len(w) < 2 || aiEnStopWords[w] {
			return
		}
		addFeat("w:"+w, 2.2)
		if stem := stemSimpleEnglish(w); stem != w && len(stem) >= 3 {
			addFeat("s:"+stem, 1.6)
		}
		padded := "^" + w + "$"
		pr := []rune(padded)
		for i := 0; i+3 <= len(pr); i++ {
			addFeat("g:"+string(pr[i:i+3]), 0.85)
		}
	}

	flushCJK := func() {
		if len(cjkBuf) == 0 {
			return
		}
		// Keep non-stop CJK runes for semantic hashing.
		filtered := cjkBuf[:0]
		for _, r := range cjkBuf {
			if !aiZhStopRunes[r] {
				filtered = append(filtered, r)
			}
		}
		for i, r := range filtered {
			addFeat("cu:"+string(r), 0.75)
			if i+1 < len(filtered) {
				addFeat("cb:"+string(filtered[i:i+2]), 1.8)
			}
			if i+2 < len(filtered) {
				addFeat("ct:"+string(filtered[i:i+3]), 1.2)
			}
		}
		cjkBuf = cjkBuf[:0]
	}

	for _, r := range folded {
		switch {
		case unicode.Is(unicode.Han, r):
			flushWord()
			cjkBuf = append(cjkBuf, r)
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			flushCJK()
			wordBuf.WriteRune(r)
		default:
			flushWord()
			flushCJK()
		}
	}
	flushWord()
	flushCJK()

	if len(feats) == 0 {
		return vec
	}

	var acc [localEmbeddingDims]float64
	for feat, fw := range feats {
		h := fnv.New64a()
		_, _ = h.Write([]byte(feat))
		sum := h.Sum64()
		bucket := int(sum % localEmbeddingDims)
		sign := 1.0
		if (sum >> 63) == 1 {
			sign = -1.0
		}
		w := fw.base * (1.0 + math.Log(float64(fw.count)))
		acc[bucket] += sign * w
	}

	var normSq float64
	for _, v := range acc {
		normSq += v * v
	}
	if normSq == 0 {
		return vec
	}
	invNorm := 1.0 / math.Sqrt(normSq)
	for i, v := range acc {
		vec[i] = float32(v * invNorm)
	}
	return vec
}

func normalizeVector(in []float32) []float32 {
	var normSq float64
	for _, v := range in {
		normSq += float64(v) * float64(v)
	}
	if normSq == 0 {
		return slices.Clone(in)
	}
	inv := 1.0 / math.Sqrt(normSq)
	out := make([]float32, len(in))
	for i, v := range in {
		out[i] = float32(float64(v) * inv)
	}
	return out
}

func cosineSimilarity(a, b []float32) float64 {
	if len(a) == 0 || len(a) != len(b) {
		return 0
	}
	var dot, na, nb float64
	for i := range a {
		fa := float64(a[i])
		fb := float64(b[i])
		dot += fa * fb
		na += fa * fa
		nb += fb * fb
	}
	if na == 0 || nb == 0 {
		return 0
	}
	cos := dot / (math.Sqrt(na) * math.Sqrt(nb))
	if cos > 1 {
		return 1
	}
	if cos < -1 {
		return -1
	}
	return cos
}

func embeddingContentHash(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

func configuredEmbeddingModel() string {
	if env := strings.TrimSpace(os.Getenv("JIANGE_AI_EMBEDDING_MODEL")); env != "" && reAIModel.MatchString(env) {
		return env
	}
	return aiDefaultEmbeddingModel
}

// tryRemoteEmbeddings fetches OpenAI-compatible /embeddings in a single batch
// with a short timeout and returns ok=false on any error so callers silently
// fall back to ComputeLocalEmbedding.
func (s *Server) tryRemoteEmbeddings(ctx context.Context, userID int64, inputs []string) ([][]float32, string, bool) {
	if len(inputs) == 0 || len(inputs) > aiRemoteEmbeddingBatchLimit || len(s.AISecret) != 32 {
		return nil, "", false
	}
	cur, err := s.Store.AISettings(ctx, userID)
	if err != nil {
		return nil, "", false
	}
	provider, ok := normalizeProvider(cur.Provider)
	if !ok || provider != "openai" {
		return nil, "", false
	}
	key, err := openAIKey(s.AISecret, userID, cur.APIKeyCipher)
	if err != nil {
		return nil, "", false
	}
	base, ok := s.normalizeAIBase(cur.BaseURL, provider)
	if !ok {
		return nil, "", false
	}
	model := configuredEmbeddingModel()

	trimmed := make([]string, len(inputs))
	for i, s := range inputs {
		trimmed[i] = truncateRunes(strings.TrimSpace(s), 4000)
	}
	body, err := json.Marshal(map[string]any{
		"model": model,
		"input": trimmed,
	})
	if err != nil {
		return nil, "", false
	}

	embCtx, cancel := context.WithTimeout(ctx, 2500*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(embCtx, http.MethodPost, base+"/embeddings", bytes.NewReader(body))
	if err != nil {
		return nil, "", false
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+key)

	res, err := s.aiClient().Do(req)
	if err != nil {
		return nil, "", false
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, "", false
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, aiMaxResponse*4))
	if err != nil {
		return nil, "", false
	}
	var out struct {
		Data []struct {
			Index     int       `json:"index"`
			Embedding []float32 `json:"embedding"`
		} `json:"data"`
	}
	if json.Unmarshal(raw, &out) != nil || len(out.Data) != len(inputs) {
		return nil, "", false
	}
	vecs := make([][]float32, len(inputs))
	dims := 0
	for _, item := range out.Data {
		if item.Index < 0 || item.Index >= len(inputs) || len(item.Embedding) == 0 {
			return nil, "", false
		}
		if dims == 0 {
			dims = len(item.Embedding)
		} else if len(item.Embedding) != dims {
			return nil, "", false
		}
		vecs[item.Index] = normalizeVector(item.Embedding)
	}
	for _, v := range vecs {
		if len(v) == 0 {
			return nil, "", false
		}
	}
	return vecs, model, true
}

type aiSearchTerm struct {
	text     string
	weight   float64
	isBigram bool
}

var aiEnStopWords = map[string]bool{
	"the": true, "and": true, "for": true, "with": true, "what": true, "how": true,
	"who": true, "why": true, "when": true, "where": true, "which": true, "are": true,
	"was": true, "were": true, "been": true, "being": true, "have": true, "has": true,
	"had": true, "does": true, "did": true, "can": true, "could": true, "would": true,
	"should": true, "will": true, "from": true, "that": true, "this": true, "these": true,
	"those": true, "into": true, "about": true, "please": true, "tell": true, "find": true,
	"show": true, "list": true, "give": true, "our": true, "your": true, "their": true,
}

var aiZhStopPhrases = []string{
	"请问", "帮我", "帮忙", "一下", "什么", "怎么", "如何", "哪些", "有关", "关于",
	"查找", "查询", "搜索", "找出", "列出", "总结", "梳理", "概括", "查看", "整理",
	"目前", "当前", "现在", "我们", "这个", "那个", "以及", "还有", "是否", "可以",
	"一下", "情况", "内容", "文档", "资料", "信息",
}

var aiZhStopRunes = map[rune]bool{
	'的': true, '了': true, '和': true, '与': true, '及': true, '在': true,
	'是': true, '有': true, '对': true, '把': true, '被': true, '为': true,
	'吗': true, '呢': true, '吧': true, '啊': true, '么': true, '个': true,
	'中': true, '上': true, '下': true, '里': true, '去': true, '来': true,
}

func extractQueryTerms(question string) []aiSearchTerm {
	fold := cases.Fold().String(strings.TrimSpace(question))
	if fold == "" {
		return nil
	}
	seen := map[string]bool{}
	terms := make([]aiSearchTerm, 0, 16)
	add := func(tok string, weight float64, isBigram bool) {
		tok = strings.TrimSpace(tok)
		if tok == "" || seen[tok] {
			return
		}
		seen[tok] = true
		terms = append(terms, aiSearchTerm{text: tok, weight: weight, isBigram: isBigram})
	}

	// Split ASCII alphanumeric tokens first.
	var asciiBuf strings.Builder
	flushASCII := func() {
		if asciiBuf.Len() == 0 {
			return
		}
		tok := asciiBuf.String()
		asciiBuf.Reset()
		if len(tok) >= 2 && !aiEnStopWords[tok] {
			add(tok, 2.2, false)
		}
	}

	// Collect contiguous CJK runs.
	var cjkRuns []string
	var cjkBuf strings.Builder
	flushCJK := func() {
		if cjkBuf.Len() == 0 {
			return
		}
		cjkRuns = append(cjkRuns, cjkBuf.String())
		cjkBuf.Reset()
	}

	for _, r := range fold {
		if unicode.Is(unicode.Han, r) {
			flushASCII()
			cjkBuf.WriteRune(r)
		} else if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			flushCJK()
			asciiBuf.WriteRune(r)
		} else {
			flushASCII()
			flushCJK()
		}
	}
	flushASCII()
	flushCJK()

	for _, run := range cjkRuns {
		cleaned := run
		for _, ph := range aiZhStopPhrases {
			cleaned = strings.ReplaceAll(cleaned, ph, " ")
		}
		// Split cleaned run on stop runes as well.
		var piece strings.Builder
		emitPiece := func() {
			p := piece.String()
			piece.Reset()
			rc := utf8.RuneCountInString(p)
			if rc < 2 {
				return
			}
			add(p, 2.6, false)
			if rc >= 3 {
				rr := []rune(p)
				for i := 0; i+1 < len(rr); i++ {
					add(string(rr[i:i+2]), 1.0, true)
				}
			}
		}
		for _, r := range cleaned {
			if r == ' ' || aiZhStopRunes[r] {
				emitPiece()
			} else {
				piece.WriteRune(r)
			}
		}
		emitPiece()
	}

	// If stop-word removal eliminated everything (e.g. a very short generic query),
	// keep original runs/words so search still runs cleanly.
	if len(terms) == 0 {
		for _, run := range cjkRuns {
			rc := utf8.RuneCountInString(run)
			if rc >= 2 {
				add(run, 1.5, false)
				rr := []rune(run)
				for i := 0; i+1 < len(rr); i++ {
					add(string(rr[i:i+2]), 0.8, true)
				}
			} else if rc == 1 {
				add(run, 1.0, false)
			}
		}
	}
	if len(terms) > 24 {
		terms = terms[:24]
	}
	return terms
}

func isBroadOverviewQuery(question string) bool {
	q := cases.Fold().String(question)
	// If the user included a specific Latin/numeric code (e.g., "X999", "alpha-2"),
	// treat it as a specific search, not a generic overview.
	for _, tok := range extractQueryTerms(question) {
		if !tok.isBigram && isLikelyEnglish(tok.text) {
			switch tok.text {
			case "summary", "summarize", "overview", "recent", "progress", "weekly", "update", "updates", "todo", "todos", "risk", "risks":
			default:
				return false
			}
		}
	}
	for _, kw := range []string{
		"总结", "进展", "概览", "近期", "最近", "本周", "周报", "日报",
		"待办", "风险", "汇总", "梳理", "summary", "summarize", "overview",
		"recent", "progress", "weekly", "todo", "risk",
	} {
		if strings.Contains(q, kw) {
			return true
		}
	}
	return false
}

func (s *Server) extractAccessibleDocText(ctx context.Context, r *http.Request, uid int64, fresh store.DocMeta, idxStore store.SearchIndexStore, hasIndex bool) (string, bool) {
	switch fresh.Kind {
	case "doc":
		epoch, head, err := s.Store.HeadVersion(ctx, fresh.ID)
		if err != nil {
			return "", false
		}
		if hasIndex {
			if entry, err := idxStore.GetSearchIndex(ctx, fresh.ID); err == nil && entry.SourceEpoch == epoch && entry.SourceSeq == head {
				return entry.BodyText, true
			}
		}
		doc, seq, err := StateAtHead(ctx, s.Store, fresh.ID)
		if err != nil {
			return "", false
		}
		if doc.HasTables() {
			return "", true
		}
		body := extractSearchableDocumentText(doc.View())
		if hasIndex {
			if afterEpoch, afterHead, err := s.Store.HeadVersion(ctx, fresh.ID); err == nil && afterHead == seq {
				_ = idxStore.UpsertSearchIndex(ctx, store.SearchIndexEntry{
					NodeID:      fresh.ID,
					SourceEpoch: afterEpoch,
					SourceSeq:   seq,
					SourceStamp: fresh.UpdatedAt,
					BodyText:    body,
				})
			}
		}
		return body, true

	case "base":
		restricted, err := s.baseRestricted(ctx, fresh)
		if err != nil {
			return "", false
		}
		if restricted {
			readCtx := ctx
			if fresh.Role != store.RoleManage {
				subj := s.resolveBaseSubject(ctx, r, uid, fresh.WorkspaceID)
				readCtx = withRBACSubject(ctx, fresh.WorkspaceID, subj)
			}
			tables, err := s.Store.BaseTables(readCtx, fresh.ID)
			if err != nil {
				return "", false
			}
			if len(tables) == 0 {
				allowed, err := s.readBaseAllowed(readCtx, uid, fresh.ID)
				if err != nil {
					return "", false
				}
				return extractSearchableBaseText(allowed.tables, allowed.fields, allowed.records), true
			}
			var b strings.Builder
			for _, tbl := range tables {
				allowed, err := readBaseTableAllowedWith(readCtx, s.Store, uid, fresh.ID, tbl.ID)
				if err != nil {
					continue
				}
				appendSearchSegment(&b, extractSearchableBaseText([]store.BaseTable{tbl}, allowed.fields, allowed.records))
			}
			return b.String(), true
		}
		tables, err := s.Store.BaseTables(ctx, fresh.ID)
		if err != nil {
			return "", false
		}
		fields, err := s.Store.Fields(ctx, fresh.ID)
		if err != nil {
			return "", false
		}
		records, err := s.Store.Records(ctx, fresh.ID)
		if err != nil {
			return "", false
		}
		return extractSearchableBaseText(tables, fields, records), true

	case "slides":
		pages, err := s.Store.ListSlidesPages(ctx, uid, fresh.ID)
		if err != nil {
			return "", false
		}
		return extractSearchableSlidesText(pages), true

	case "survey":
		ss, ok := s.Store.(store.SurveyStore)
		if !ok {
			return "", true
		}
		sv, err := ss.GetSurvey(ctx, fresh.ID)
		if err != nil {
			return "", false
		}
		return extractSearchableSurveyText(sv), true

	case "sheet":
		if r != nil {
			if c, err := r.Cookie(CookieName); err == nil && c.Value != "" {
				guard := store.RestoreGuard{UserID: uid, SessionHash: auth.HashToken(c.Value), Now: s.now}
				if snap, err := s.Store.GetSheetWorkbook(ctx, guard, fresh.ID); err == nil {
					return extractAIWorkspaceSheetText(snap), true
				}
			}
		}
		return "", true
	}
	return "", true
}

func extractAIWorkspaceSheetText(snap store.SheetSnapshot) string {
	var b strings.Builder
	for _, ws := range snap.Sheets {
		appendSearchSegment(&b, ws.Title)
		for _, cell := range ws.Cells {
			raw := strings.TrimSpace(cell.Raw)
			if raw == "" || strings.HasPrefix(raw, "=") {
				continue
			}
			appendSearchSegment(&b, raw)
		}
	}
	return b.String()
}

func scoreDocumentForRAG(title, bodyText, foldedQuestion string, terms []aiSearchTerm) (float64, string) {
	fold := cases.Fold()
	foldedTitle := fold.String(title)
	segments := strings.Split(bodyText, searchSegmentSep)
	cleanSegs := make([]string, 0, len(segments))
	for _, seg := range segments {
		s := strings.Join(strings.Fields(seg), " ")
		if s != "" {
			cleanSegs = append(cleanSegs, s)
		}
	}

	var score float64
	if foldedQuestion != "" && strings.Contains(foldedTitle, foldedQuestion) {
		score += 12.0
	}

	bestSegIdx := -1
	bestSegScore := 0.0
	matchedTerms := map[string]bool{}

	for _, term := range terms {
		if strings.Contains(foldedTitle, term.text) {
			score += 3.0 * term.weight
			matchedTerms[term.text] = true
		}
	}

	for idx, seg := range cleanSegs {
		fseg := fold.String(seg)
		segScore := 0.0
		if foldedQuestion != "" && strings.Contains(fseg, foldedQuestion) {
			segScore += 6.0
		}
		for _, term := range terms {
			cnt := strings.Count(fseg, term.text)
			if cnt > 0 {
				matchedTerms[term.text] = true
				extra := float64(min(cnt-1, 4)) * 0.3
				segScore += (1.2 + extra) * term.weight
			}
		}
		if segScore > 0 {
			score += segScore
			if segScore > bestSegScore {
				bestSegScore = segScore
				bestSegIdx = idx
			}
		}
	}

	if len(terms) > 0 && len(matchedTerms) > 0 {
		score += 3.0 * (float64(len(matchedTerms)) / float64(len(terms)))
	}

	snippet := buildRAGSnippet(cleanSegs, bestSegIdx, title)
	return math.Round(score*100) / 100, snippet
}

func buildRAGSnippet(segs []string, bestIdx int, title string) string {
	if len(segs) == 0 {
		return truncateRunes(title, 160)
	}
	start := bestIdx
	if start < 0 {
		start = 0
	}
	var b strings.Builder
	for i := start; i < len(segs); i++ {
		if b.Len() > 0 {
			b.WriteString(" · ")
		}
		b.WriteString(segs[i])
		if utf8.RuneCountInString(b.String()) >= 180 {
			break
		}
	}
	out := strings.TrimSpace(b.String())
	if utf8.RuneCountInString(out) > 180 {
		return truncateRunes(out, 179) + "…"
	}
	return out
}

func (s *Server) retrieveWorkspaceCitations(ctx context.Context, r *http.Request, uid int64, question string, workspaceID, wikiSpaceID int64) ([]aiWorkspaceCitation, error) {
	const pageSize = 100
	idxStore, hasIndex := s.Store.(store.SearchIndexStore)
	attStore, hasAttStore := s.Store.(store.AttachmentTextStore)
	embStore, hasEmbStore := s.Store.(store.EmbeddingStore)

	foldedQ := cases.Fold().String(strings.TrimSpace(question))
	terms := extractQueryTerms(question)

	type ragCandidate struct {
		meta              store.DocMeta
		bodyText          string
		restricted        bool
		canUseAttachments bool
		canonicalText     string
		contentHash       string
		lexScore          float64
		snippet           string
		vector            []float32
		score             float64
	}
	candidates := make([]ragCandidate, 0, 32)
	attDocIDs := make([]int64, 0, 32)
	cacheableDocIDs := make([]int64, 0, 32)

	var after int64
	scanned := 0

	for scanned < aiWorkspaceMaxCandidates {
		page, err := s.Store.SearchCandidates(ctx, uid, after, pageSize)
		if err != nil {
			return nil, err
		}
		if len(page) == 0 {
			break
		}
		for _, cand := range page {
			after = cand.ID
			scanned++
			if cand.Kind == "folder" {
				continue
			}
			fresh, err := s.Store.GetDoc(ctx, uid, cand.ID)
			if errors.Is(err, store.ErrNotFound) {
				continue
			}
			if err != nil {
				return nil, err
			}
			if workspaceID > 0 && fresh.WorkspaceID != workspaceID {
				continue
			}
			if wikiSpaceID > 0 && (fresh.WikiSpaceID == nil || *fresh.WikiSpaceID != wikiSpaceID) {
				continue
			}
			// Strictly enforce read + copy permission before reading any content.
			if store.RoleRank(fresh.Role) < store.RoleRank(store.RoleView) || !store.DocumentCopyAllowed(fresh, fresh.Role) {
				continue
			}
			restricted := false
			if fresh.Kind == "base" {
				rFlag, rErr := s.baseRestricted(ctx, fresh)
				if rErr != nil {
					continue
				}
				restricted = rFlag
			}
			bodyText, ok := s.extractAccessibleDocText(ctx, r, uid, fresh, idxStore, hasIndex)
			if !ok {
				continue
			}
			canUseAtt := !restricted && store.DocumentDownloadAllowed(fresh, fresh.Role)
			if canUseAtt {
				attDocIDs = append(attDocIDs, fresh.ID)
			}
			if !restricted {
				cacheableDocIDs = append(cacheableDocIDs, fresh.ID)
			}
			candidates = append(candidates, ragCandidate{
				meta:              fresh,
				bodyText:          bodyText,
				restricted:        restricted,
				canUseAttachments: canUseAtt,
			})
			if scanned >= aiWorkspaceMaxCandidates {
				break
			}
		}
		if len(page) < pageSize {
			break
		}
	}

	// Merge extracted attachment full text into accessible candidates.
	var attMap map[int64][]store.AttachmentTextEntry
	if hasAttStore && len(attDocIDs) > 0 {
		if loaded, err := attStore.ListAttachmentTextsByDocs(ctx, attDocIDs); err == nil {
			attMap = loaded
		}
	}

	filtered := candidates[:0]
	for i := range candidates {
		c := &candidates[i]
		if c.canUseAttachments && len(attMap[c.meta.ID]) > 0 {
			var b strings.Builder
			if c.bodyText != "" {
				b.WriteString(c.bodyText)
			}
			for _, att := range attMap[c.meta.ID] {
				for _, line := range strings.Split(att.ExtractedText, "\n") {
					line = strings.TrimSpace(line)
					if line == "" {
						continue
					}
					if c.meta.Kind == "file" {
						appendSearchSegment(&b, line)
					} else {
						appendSearchSegment(&b, fmt.Sprintf("[附件 %s] %s", att.Filename, line))
					}
				}
			}
			c.bodyText = b.String()
		}
		// Skip opaque binary Drive files with no extracted text unless their title can match.
		if c.meta.Kind == "file" && c.bodyText == "" && strings.TrimSpace(c.meta.Title) == "" {
			continue
		}

		// Lexical BM25-style score + best matching snippet.
		lexScore, snippet := scoreDocumentForRAG(c.meta.Title, c.bodyText, foldedQ, terms)
		if c.meta.Kind == "sheet" && c.bodyText == "" && lexScore == 0 {
			for _, term := range terms {
				if matched, sErr := s.Store.SearchSheetContent(ctx, uid, c.meta.ID, term.text); sErr == nil && matched {
					lexScore += 1.5 * term.weight
				}
			}
		}
		c.lexScore = lexScore
		c.snippet = snippet

		plainBody := strings.ReplaceAll(c.bodyText, searchSegmentSep, "\n")
		c.canonicalText = truncateRunes(strings.TrimSpace(c.meta.Title+"\n"+plainBody), 12000)
		c.contentHash = embeddingContentHash(c.canonicalText)
		filtered = append(filtered, *c)
	}
	candidates = filtered

	// Load cached document embeddings from doc_embeddings.
	var cachedEmbeddings map[int64]store.DocEmbedding
	if hasEmbStore && len(cacheableDocIDs) > 0 {
		if loaded, err := embStore.GetDocEmbeddings(ctx, cacheableDocIDs); err == nil {
			cachedEmbeddings = loaded
		}
	}

	// Attempt optional remote OpenAI-compatible /embeddings with automatic silent fallback.
	var qVec []float32
	activeModel := localEmbeddingModel
	if len(candidates) > 0 {
		remoteModel := configuredEmbeddingModel()
		batchInputs := []string{question}
		batchIdx := []int{}
		for i := range candidates {
			c := &candidates[i]
			if !c.restricted {
				if cached, ok := cachedEmbeddings[c.meta.ID]; ok &&
					cached.Model == remoteModel &&
					cached.ContentHash == c.contentHash &&
					len(cached.Vector) > 0 {
					continue
				}
			}
			if len(batchInputs) < aiRemoteEmbeddingBatchLimit {
				batchInputs = append(batchInputs, c.canonicalText)
				batchIdx = append(batchIdx, i)
			}
		}
		if vecs, usedModel, ok := s.tryRemoteEmbeddings(ctx, uid, batchInputs); ok {
			activeModel = usedModel
			qVec = vecs[0]
			for j, candIdx := range batchIdx {
				c := &candidates[candIdx]
				c.vector = vecs[j+1]
				if hasEmbStore && !c.restricted {
					_ = embStore.UpsertDocEmbedding(ctx, store.DocEmbedding{
						DocID:       c.meta.ID,
						WorkspaceID: c.meta.WorkspaceID,
						Model:       activeModel,
						ContentHash: c.contentHash,
						Dimensions:  len(c.vector),
						Vector:      c.vector,
						Excerpt:     c.snippet,
					})
				}
			}
			for i := range candidates {
				c := &candidates[i]
				if len(c.vector) > 0 || c.restricted {
					continue
				}
				if cached, ok := cachedEmbeddings[c.meta.ID]; ok &&
					cached.Model == activeModel &&
					cached.ContentHash == c.contentHash &&
					len(cached.Vector) == len(qVec) {
					c.vector = cached.Vector
				}
			}
		}
	}

	// Local 128-dim deterministic semantic vector encoder (default / silent fallback).
	if len(qVec) == 0 {
		activeModel = localEmbeddingModel
		qVec = ComputeLocalEmbedding(question)
		for i := range candidates {
			c := &candidates[i]
			if !c.restricted {
				if cached, ok := cachedEmbeddings[c.meta.ID]; ok &&
					cached.Model == localEmbeddingModel &&
					cached.ContentHash == c.contentHash &&
					len(cached.Vector) == localEmbeddingDims {
					c.vector = cached.Vector
					continue
				}
			}
			c.vector = ComputeLocalEmbedding(c.canonicalText)
			if hasEmbStore && !c.restricted {
				_ = embStore.UpsertDocEmbedding(ctx, store.DocEmbedding{
					DocID:       c.meta.ID,
					WorkspaceID: c.meta.WorkspaceID,
					Model:       localEmbeddingModel,
					ContentHash: c.contentHash,
					Dimensions:  len(c.vector),
					Vector:      c.vector,
					Excerpt:     c.snippet,
				})
			}
		}
	}

	// Hybrid Retrieval Scoring: 0.55 * cosineSimilarity + 0.45 * normalizedLexicalBM25.
	matched := make([]ragCandidate, 0, len(candidates))
	for i := range candidates {
		c := &candidates[i]
		cosSim := math.Max(0, cosineSimilarity(qVec, c.vector))
		normLex := 0.0
		if c.lexScore > 0 {
			normLex = c.lexScore / (c.lexScore + 6.0)
		}
		if c.lexScore > 0 || cosSim >= aiSemanticOnlyThreshold {
			hybrid := 0.55*cosSim + 0.45*normLex
			c.score = math.Round(hybrid*10000) / 10000
			if c.score > 0 {
				matched = append(matched, *c)
			}
		}
	}

	// Broad overview queries (e.g. "总结本周核心进展") fall back to recent accessible docs
	// only when no direct lexical or semantic hit matched, while strictly obeying ACL + copy policies.
	if len(matched) == 0 && len(candidates) > 0 && isBroadOverviewQuery(question) {
		sort.Slice(candidates, func(i, j int) bool {
			if candidates[i].meta.UpdatedAt.Equal(candidates[j].meta.UpdatedAt) {
				return candidates[i].meta.ID > candidates[j].meta.ID
			}
			return candidates[i].meta.UpdatedAt.After(candidates[j].meta.UpdatedAt)
		})
		limit := min(3, len(candidates))
		for i := 0; i < limit; i++ {
			item := candidates[i]
			item.score = 0.5
			matched = append(matched, item)
		}
	}

	sort.Slice(matched, func(i, j int) bool {
		if matched[i].score != matched[j].score {
			return matched[i].score > matched[j].score
		}
		if !matched[i].meta.UpdatedAt.Equal(matched[j].meta.UpdatedAt) {
			return matched[i].meta.UpdatedAt.After(matched[j].meta.UpdatedAt)
		}
		return matched[i].meta.ID > matched[j].meta.ID
	})

	citations := make([]aiWorkspaceCitation, 0, min(len(matched), aiWorkspaceMaxCitations))
	for _, item := range matched {
		if len(citations) >= aiWorkspaceMaxCitations {
			break
		}
		// Recheck live permission + copy policy before returning citation.
		recheck, err := s.Store.GetDoc(ctx, uid, item.meta.ID)
		if err != nil || store.RoleRank(recheck.Role) < store.RoleRank(store.RoleView) || !store.DocumentCopyAllowed(recheck, recheck.Role) {
			continue
		}
		title := strings.TrimSpace(recheck.Title)
		if title == "" {
			title = "未命名文档"
		}
		kind := recheck.Kind
		if kind == "" {
			kind = "doc"
		}
		citations = append(citations, aiWorkspaceCitation{
			DocID:       recheck.ID,
			Title:       title,
			Kind:        kind,
			WikiSpaceID: recheck.WikiSpaceID,
			Snippet:     item.snippet,
			Score:       item.score,
		})
	}
	return citations, nil
}

func buildWorkspaceRAGMessages(question string, history []aiMessage, citations []aiWorkspaceCitation) []aiMessage {
	var ctxBuf strings.Builder
	if len(citations) == 0 {
		ctxBuf.WriteString("（当前空间内未检索到匹配的可访问文档。）")
	} else {
		for i, c := range citations {
			fmt.Fprintf(&ctxBuf, "[%d] 标题：%s（类型：%s）\n摘要：%s\n\n", i+1, c.Title, c.Kind, c.Snippet)
		}
	}
	sys := "你是工作空间知识库 AI 助手。请严格基于下方检索到的参考文档回答问题，并在对应结论后使用 [1]、[2] 标注引用来源。如果参考文档中未提及相关信息，请明确说明，不要编造。保持回答简洁、结构清晰，并与用户提问语言一致。\n\n参考文档：\n" + ctxBuf.String()
	msgs := make([]aiMessage, 0, len(history)+2)
	msgs = append(msgs, aiMessage{Role: "system", Content: sys})
	msgs = append(msgs, history...)
	msgs = append(msgs, aiMessage{Role: "user", Content: question})
	return msgs
}

func synthesizeLocalRAGAnswer(question string, citations []aiWorkspaceCitation) string {
	en := isLikelyEnglish(question)
	if len(citations) == 0 {
		if en {
			return fmt.Sprintf("No accessible documents matched %q in the current workspace. Try using broader keywords, or note that private and copy-restricted documents are excluded.", question)
		}
		return fmt.Sprintf("未在当前有权限访问的知识库文档中找到与「%s」直接匹配的内容。你可以尝试更换更精简的关键词；受权限隔离或禁止复制保护的文档不会参与检索。", question)
	}
	var b strings.Builder
	if en {
		fmt.Fprintf(&b, "Based on %d accessible document(s) related to %q:\n\n", len(citations), question)
		for i, c := range citations {
			fmt.Fprintf(&b, "- **%s** [%d]: %s\n", c.Title, i+1, c.Snippet)
		}
		b.WriteString("\nClick any citation below to open the source document.")
	} else {
		fmt.Fprintf(&b, "基于当前工作空间内 %d 篇可访问的相关文档，为你整理与「%s」相关的核心信息：\n\n", len(citations), question)
		for i, c := range citations {
			fmt.Fprintf(&b, "- **《%s》** [%d]：%s\n", c.Title, i+1, c.Snippet)
		}
		b.WriteString("\n点击下方「引用来源」可直接跳转查看原文档。")
	}
	return b.String()
}

// --- 2. Sheet AI Formula & Data Assistant ---

func (s *Server) aiSheetAssist(w http.ResponseWriter, r *http.Request) {
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "login required")
		return
	}
	var in aiSheetAssistReq
	if !httpx.Decode(w, r, &in) {
		return
	}
	prompt := strings.TrimSpace(in.Prompt)
	if prompt == "" || utf8.RuneCountInString(prompt) > aiWorkspaceMaxQuestion {
		httpx.Error(w, http.StatusBadRequest, "invalid_prompt", "请输入 1-2000 字的需求描述")
		return
	}
	if !s.aiRate.allow(u.ID, s.now()) {
		httpx.Error(w, http.StatusTooManyRequests, "ai_rate_limited", "请求过于频繁，请稍后再试")
		return
	}

	headers := in.Headers
	if len(headers) > aiSheetMaxHeaders {
		headers = headers[:aiSheetMaxHeaders]
	}
	cleanHeaders := make([]string, len(headers))
	for i, h := range headers {
		cleanHeaders[i] = strings.TrimSpace(truncateRunes(h, 80))
	}
	sampleRows := in.SampleRows
	if len(sampleRows) > aiSheetMaxSampleRows {
		sampleRows = sampleRows[:aiSheetMaxSampleRows]
	}
	cleanRows := make([][]string, len(sampleRows))
	for i, row := range sampleRows {
		lim := min(len(row), aiSheetMaxHeaders)
		cr := make([]string, lim)
		for j := 0; j < lim; j++ {
			cr[j] = strings.TrimSpace(truncateRunes(row[j], 120))
		}
		cleanRows[i] = cr
	}
	activeCell := strings.TrimSpace(truncateRunes(in.ActiveCell, 16))
	sheetTitle := strings.TrimSpace(truncateRunes(in.SheetTitle, 100))

	w.Header().Set("Cache-Control", "no-store")
	if _, ready := s.configuredAIModel(r.Context(), u.ID); ready {
		msgs := buildSheetAssistMessages(prompt, cleanHeaders, cleanRows, activeCell, sheetTitle)
		text, aiErr := s.callAI(r.Context(), u.ID, msgs)
		if aiErr == nil && strings.TrimSpace(text) != "" {
			resp := parseSheetAssistLLMResponse(text)
			resp.Mode = "llm"
			httpx.JSON(w, http.StatusOK, resp)
			return
		}
		if isBlockedAIError(aiErr) {
			s.aiError(w, r, aiErr)
			return
		}
	}

	resp := localSheetAssist(prompt, cleanHeaders, cleanRows, activeCell, sheetTitle)
	httpx.JSON(w, http.StatusOK, resp)
}

func sheetColLetter(idx int) string {
	if idx < 0 {
		idx = 0
	}
	var out []byte
	n := idx + 1
	for n > 0 {
		rem := (n - 1) % 26
		out = append(out, byte('A'+rem))
		n = (n - 1) / 26
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return string(out)
}

var reCellRef = regexp.MustCompile(`^([A-Za-z]+)(\d+)$`)
var reFormulaExtract = regexp.MustCompile(`(?m)(=[\p{L}A-Z0-9_.]+\([^\n\r` + "`" + `]*\))`)

func parseActiveCellRow(activeCell string) int {
	m := reCellRef.FindStringSubmatch(strings.TrimSpace(activeCell))
	if len(m) != 3 {
		return 0
	}
	row, err := strconv.Atoi(m[2])
	if err != nil || row <= 0 {
		return 0
	}
	return row
}

func parseSampleNumber(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	isPct := strings.HasSuffix(s, "%")
	cleaned := strings.TrimSpace(strings.TrimSuffix(s, "%"))
	cleaned = strings.NewReplacer(",", "", "¥", "", "$", "", "€", "", "£", "").Replace(cleaned)
	v, err := strconv.ParseFloat(cleaned, 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, false
	}
	if isPct {
		v /= 100
	}
	return v, true
}

func formatCompactNumber(v float64) string {
	if math.Abs(v-math.Round(v)) < 1e-9 {
		return strconv.FormatInt(int64(math.Round(v)), 10)
	}
	return strconv.FormatFloat(math.Round(v*100)/100, 'f', -1, 64)
}

type sheetColStats struct {
	count int
	sum   float64
	avg   float64
	min   float64
	max   float64
}

func computeColStats(rows [][]string, col int) sheetColStats {
	st := sheetColStats{}
	for _, row := range rows {
		if col >= len(row) {
			continue
		}
		if v, ok := parseSampleNumber(row[col]); ok {
			if st.count == 0 {
				st.min, st.max = v, v
			} else {
				if v < st.min {
					st.min = v
				}
				if v > st.max {
					st.max = v
				}
			}
			st.count++
			st.sum += v
		}
	}
	if st.count > 0 {
		st.avg = st.sum / float64(st.count)
	}
	return st
}

func localSheetAssist(prompt string, headers []string, sampleRows [][]string, activeCell, sheetTitle string) aiSheetAssistResp {
	lower := cases.Fold().String(prompt)
	numCols := len(headers)
	for _, row := range sampleRows {
		if len(row) > numCols {
			numCols = len(row)
		}
	}
	if numCols == 0 {
		numCols = 2
	}

	// Detect category (text) column and primary numeric column from headers & samples.
	catCol := 0
	numCol := -1
	bestNumCount := 0
	for c := 0; c < numCols; c++ {
		st := computeColStats(sampleRows, c)
		if st.count > bestNumCount {
			bestNumCount = st.count
			numCol = c
		}
	}
	// Prefer a header explicitly mentioned in the prompt.
	matchedCol := -1
	emailCol := -1
	phoneCol := -1
	for i, h := range headers {
		fh := cases.Fold().String(h)
		if fh == "" {
			continue
		}
		if strings.Contains(fh, "邮箱") || strings.Contains(fh, "email") || strings.Contains(fh, "mail") {
			emailCol = i
		}
		if strings.Contains(fh, "手机") || strings.Contains(fh, "电话") || strings.Contains(fh, "phone") {
			phoneCol = i
		}
		if strings.Contains(lower, fh) {
			matchedCol = i
		}
	}
	if matchedCol >= 0 {
		st := computeColStats(sampleRows, matchedCol)
		if st.count > 0 || numCol < 0 {
			numCol = matchedCol
		}
	}
	if numCol < 0 {
		if numCols >= 2 {
			numCol = 1
		} else {
			numCol = 0
		}
	}
	if catCol == numCol && numCols >= 2 {
		catCol = 0
		if numCol == 0 {
			catCol = 1
		}
	}

	endRow := len(sampleRows) + 1
	if endRow < 2 {
		endRow = 20
	}
	if acRow := parseActiveCellRow(activeCell); acRow >= 3 && acRow <= endRow {
		endRow = acRow - 1
	}

	catLetter := sheetColLetter(catCol)
	numLetter := sheetColLetter(numCol)
	lastLetter := sheetColLetter(max(numCols-1, 1))
	numRange := fmt.Sprintf("%s2:%s%d", numLetter, numLetter, endRow)
	catRange := fmt.Sprintf("%s2:%s%d", catLetter, catLetter, endRow)
	tableRange := fmt.Sprintf("A2:%s%d", lastLetter, endRow)
	fullTableRange := fmt.Sprintf("A1:%s%d", lastLetter, endRow)

	colLabel := func(idx int) string {
		letter := sheetColLetter(idx)
		if idx >= 0 && idx < len(headers) && headers[idx] != "" {
			return fmt.Sprintf("「%s」（%s 列）", headers[idx], letter)
		}
		return fmt.Sprintf("%s 列", letter)
	}

	stats := computeColStats(sampleRows, numCol)
	statsNote := ""
	if stats.count > 0 {
		statsNote = fmt.Sprintf(" 当前样本中 %s 共 %d 条有效数值：合计 %s，均值 %s，最大 %s，最小 %s。",
			colLabel(numCol), stats.count,
			formatCompactNumber(stats.sum), formatCompactNumber(stats.avg),
			formatCompactNumber(stats.max), formatCompactNumber(stats.min))
	}

	var formula, answer, explanation string
	switch {
	case containsAny(lower, "正则", "regex", "regexmatch", "邮箱", "email", "手机号", "校验"):
		targetIdx := matchedCol
		pattern := `"^\\w+$"`
		desc := "按正则表达式校验文本格式"
		if containsAny(lower, "邮箱", "email", "mail") {
			if targetIdx < 0 {
				if emailCol >= 0 {
					targetIdx = emailCol
				} else {
					targetIdx = catCol
				}
			}
			pattern = `"^[\\w.-]+@[\\w.-]+\\.[A-Za-z]{2,}$"`
			desc = "校验邮箱地址格式是否合法（返回 TRUE / FALSE）"
		} else if containsAny(lower, "手机", "电话", "phone") {
			if targetIdx < 0 {
				if phoneCol >= 0 {
					targetIdx = phoneCol
				} else {
					targetIdx = catCol
				}
			}
			pattern = `"^1[3-9]\\d{9}$"`
			desc = "校验中国大陆 11 位手机号格式（返回 TRUE / FALSE）"
		} else if targetIdx < 0 {
			targetIdx = catCol
		}
		refCell := fmt.Sprintf("%s2", sheetColLetter(targetIdx))
		formula = fmt.Sprintf(`=REGEXMATCH(%s, %s)`, refCell, pattern)
		answer = fmt.Sprintf("已为 %s 生成 REGEXMATCH 正则校验公式，用于%s。", colLabel(targetIdx), desc)
		explanation = fmt.Sprintf("REGEXMATCH(%s, pattern) 会检查单元格 %s 是否匹配指定正则表达式，匹配返回 TRUE，否则返回 FALSE，可向下填充整列。", refCell, refCell)

	case containsAny(lower, "let", "变量", "中间计算", "复用"):
		formula = fmt.Sprintf(`=LET(total, SUM(%s), avg, AVERAGE(%s), IF(avg=0, 0, ROUND((total-avg)/avg, 4)))`, numRange, numRange)
		answer = fmt.Sprintf("已为 %s 生成 LET 变量计算公式。%s", colLabel(numCol), statsNote)
		explanation = fmt.Sprintf("LET(name, expr, ...) 可在公式内部定义局部变量 total 与 avg，避免重复计算 %s，提升可读性与计算效率。", numRange)

	case containsAny(lower, "query", "查询", "sql", "select"):
		formula = fmt.Sprintf(`=QUERY(%s, "SELECT %s, SUM(%s) GROUP BY %s ORDER BY SUM(%s) DESC", 1)`, fullTableRange, catLetter, numLetter, catLetter, numLetter)
		answer = fmt.Sprintf("已生成 QUERY 分组聚合查询公式，按 %s 分组统计 %s 合计。%s", colLabel(catCol), colLabel(numCol), statsNote)
		explanation = fmt.Sprintf("QUERY(%s, ..., 1) 将第 1 行视为表头，按 %s 列分组并对 %s 列求和，同时按合计降序排列。", fullTableRange, catLetter, numLetter)

	case containsAny(lower, "xlookup", "vlookup", "查找", "匹配", "检索"):
		formula = fmt.Sprintf(`=XLOOKUP(%s2, %s, %s, "未找到")`, catLetter, catRange, numRange)
		answer = fmt.Sprintf("已生成 XLOOKUP 查找公式，按 %s 查找对应的 %s。", colLabel(catCol), colLabel(numCol))
		explanation = fmt.Sprintf("XLOOKUP 在 %s 中查找与 %s2 相等的行，并返回 %s 对应位置的值；未命中时返回\"未找到\"。", catRange, catLetter, numRange)

	case containsAny(lower, "unique", "去重", "唯一"):
		targetIdx := catCol
		if matchedCol >= 0 {
			targetIdx = matchedCol
		}
		tLetter := sheetColLetter(targetIdx)
		tRange := fmt.Sprintf("%s2:%s%d", tLetter, tLetter, endRow)
		formula = fmt.Sprintf(`=UNIQUE(%s)`, tRange)
		answer = fmt.Sprintf("已为 %s 生成 UNIQUE 去重公式。", colLabel(targetIdx))
		explanation = fmt.Sprintf("UNIQUE(%s) 会提取 %s 中的全部唯一值并自动向下溢出展示。", tRange, colLabel(targetIdx))

	case containsAny(lower, "filter", "筛选", "过滤"):
		if containsAny(lower, "均值", "平均", "average", "avg") {
			formula = fmt.Sprintf(`=FILTER(%s, %s>AVERAGE(%s))`, tableRange, numRange, numRange)
			answer = fmt.Sprintf("已生成动态数组筛选公式，筛选出 %s 高于平均值的记录。%s", colLabel(numCol), statsNote)
			explanation = fmt.Sprintf("FILTER(%s, %s>AVERAGE(%s)) 会动态返回数据区中 %s 列数值大于整列均值的所有行。", tableRange, numRange, numRange, numLetter)
		} else {
			formula = fmt.Sprintf(`=FILTER(%s, %s>0)`, tableRange, numRange)
			answer = fmt.Sprintf("已生成动态数组筛选公式，筛选 %s 大于 0 的数据行。%s", colLabel(numCol), statsNote)
			explanation = fmt.Sprintf("FILTER(%s, 条件) 按指定布尔条件过滤行，可将 `>0` 替换为任意阈值或相等条件。", tableRange)
		}

	case containsAny(lower, "sumif", "条件求和", "按首列", "分类汇总", "分组求和", "分组汇总"):
		formula = fmt.Sprintf(`=SUMIF(%s, %s2, %s)`, catRange, catLetter, numRange)
		answer = fmt.Sprintf("已生成按 %s 分类汇总 %s 的 SUMIF 公式。%s", colLabel(catCol), colLabel(numCol), statsNote)
		explanation = fmt.Sprintf("SUMIF(%s, %s2, %s) 会筛选 %s 列等于 %s2 的所有行，并对 %s 列对应数值求和。", catRange, catLetter, numRange, catLetter, catLetter, numLetter)

	case containsAny(lower, "countif", "条件计数", "计数", "统计个数", "count"):
		if containsAny(lower, "countif", "条件", "按", "分类") {
			formula = fmt.Sprintf(`=COUNTIF(%s, %s2)`, catRange, catLetter)
			answer = fmt.Sprintf("已生成按 %s 统计出现次数的 COUNTIF 公式。", colLabel(catCol))
			explanation = fmt.Sprintf("COUNTIF(%s, %s2) 统计 %s 中与 %s2 相同的单元格数量。", catRange, catLetter, catRange, catLetter)
		} else {
			formula = fmt.Sprintf(`=COUNT(%s)`, numRange)
			answer = fmt.Sprintf("已为 %s 生成 COUNT 数值计数公式。%s", colLabel(numCol), statsNote)
			explanation = fmt.Sprintf("COUNT(%s) 统计区域内的有效数值个数；如需统计非空文本请改用 COUNTA(%s)。", numRange, catRange)
		}

	case containsAny(lower, "average", "avg", "平均", "均值"):
		formula = fmt.Sprintf(`=AVERAGE(%s)`, numRange)
		answer = fmt.Sprintf("已为 %s 生成平均值公式。%s", colLabel(numCol), statsNote)
		explanation = fmt.Sprintf("AVERAGE(%s) 计算 %s 区域内所有数值的算术平均值，自动忽略空白单元格和文本。", numRange, colLabel(numCol))

	case containsAny(lower, "max", "最大", "最高"):
		formula = fmt.Sprintf(`=MAX(%s)`, numRange)
		answer = fmt.Sprintf("已为 %s 生成最大值公式。%s", colLabel(numCol), statsNote)
		explanation = fmt.Sprintf("MAX(%s) 返回 %s 区域中的最大数值。", numRange, colLabel(numCol))

	case containsAny(lower, "min", "最小", "最低"):
		formula = fmt.Sprintf(`=MIN(%s)`, numRange)
		answer = fmt.Sprintf("已为 %s 生成最小值公式。%s", colLabel(numCol), statsNote)
		explanation = fmt.Sprintf("MIN(%s) 返回 %s 区域中的最小数值。", numRange, colLabel(numCol))

	case containsAny(lower, "sum", "求和", "汇总", "合计", "总计", "总和"):
		formula = fmt.Sprintf(`=SUM(%s)`, numRange)
		answer = fmt.Sprintf("已为 %s 生成求和公式。%s", colLabel(numCol), statsNote)
		explanation = fmt.Sprintf("SUM(%s) 对 %s 区域内所有数值求和，可直接填入当前单元格 %s。", numRange, colLabel(numCol), activeCell)

	default:
		formula = fmt.Sprintf(`=SUM(%s)`, numRange)
		prefix := "当前工作表"
		if sheetTitle != "" {
			prefix = fmt.Sprintf("工作表「%s」", sheetTitle)
		}
		answer = fmt.Sprintf("已分析%s（共 %d 列），推荐先对 %s 使用汇总公式。%s", prefix, numCols, colLabel(numCol), statsNote)
		explanation = fmt.Sprintf("你可以继续描述更具体的公式需求，例如：SUMIF 条件求和、AVERAGE 平均值、COUNTIF 条件计数、XLOOKUP 查找、FILTER 动态筛选、UNIQUE 去重、REGEXMATCH 正则校验、QUERY 查询或 LET 变量计算。")
	}

	return aiSheetAssistResp{
		Answer:           strings.TrimSpace(answer),
		SuggestedFormula: formula,
		Explanation:      strings.TrimSpace(explanation),
		Mode:             "local",
	}
}

func containsAny(s string, subs ...string) bool {
	for _, sub := range subs {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}

func buildSheetAssistMessages(prompt string, headers []string, sampleRows [][]string, activeCell, sheetTitle string) []aiMessage {
	var ctxBuf strings.Builder
	if sheetTitle != "" {
		fmt.Fprintf(&ctxBuf, "工作表：%s\n", sheetTitle)
	}
	if activeCell != "" {
		fmt.Fprintf(&ctxBuf, "当前选中单元格：%s\n", activeCell)
	}
	if len(headers) > 0 {
		ctxBuf.WriteString("列标题（列号: 标题）：\n")
		for i, h := range headers {
			fmt.Fprintf(&ctxBuf, "- %s: %s\n", sheetColLetter(i), h)
		}
	}
	if len(sampleRows) > 0 {
		ctxBuf.WriteString("样本数据（从第 2 行开始）：\n")
		lim := min(len(sampleRows), 10)
		for i := 0; i < lim; i++ {
			fmt.Fprintf(&ctxBuf, "第 %d 行: %s\n", i+2, strings.Join(sampleRows[i], " | "))
		}
	}
	sys := "你是电子表格公式与数据分析助手，支持现代公式（SUM、SUMIF、AVERAGE、COUNTIF、XLOOKUP、FILTER、UNIQUE、REGEXMATCH、QUERY、LET、MAX、MIN 等）。请严格输出一个 JSON 对象（不要额外包裹解释）：{\"answer\":\"简短分析回答\",\"suggestedFormula\":\"=公式\",\"explanation\":\"公式原理与用法说明\"}。\n\n" + ctxBuf.String()
	return []aiMessage{
		{Role: "system", Content: sys},
		{Role: "user", Content: prompt},
	}
}

func stripCodeFence(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "```") {
		if idx := strings.Index(s, "\n"); idx >= 0 {
			s = s[idx+1:]
		}
		if end := strings.LastIndex(s, "```"); end >= 0 {
			s = s[:end]
		}
	}
	return strings.TrimSpace(s)
}

func parseSheetAssistLLMResponse(raw string) aiSheetAssistResp {
	cleaned := stripCodeFence(raw)
	var parsed struct {
		Answer           string `json:"answer"`
		SuggestedFormula string `json:"suggestedFormula"`
		Explanation      string `json:"explanation"`
	}
	if json.Unmarshal([]byte(cleaned), &parsed) == nil && (parsed.Answer != "" || parsed.SuggestedFormula != "") {
		f := strings.TrimSpace(parsed.SuggestedFormula)
		if f != "" && !strings.HasPrefix(f, "=") {
			f = "=" + f
		}
		ans := strings.TrimSpace(parsed.Answer)
		exp := strings.TrimSpace(parsed.Explanation)
		if ans == "" {
			ans = exp
		}
		if exp == "" {
			exp = ans
		}
		return aiSheetAssistResp{
			Answer:           ans,
			SuggestedFormula: f,
			Explanation:      exp,
		}
	}
	formula := ""
	if m := reFormulaExtract.FindStringSubmatch(raw); len(m) > 1 {
		formula = strings.TrimSpace(m[1])
	}
	trimmed := strings.TrimSpace(raw)
	return aiSheetAssistResp{
		Answer:           trimmed,
		SuggestedFormula: formula,
		Explanation:      trimmed,
	}
}

// --- 3. Base AI Column Batch Fill ---

func (s *Server) aiBaseFill(w http.ResponseWriter, r *http.Request) {
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "login required")
		return
	}
	var in aiBaseFillReq
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.BaseID <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_base_id", "多维表格 ID 无效")
		return
	}
	b, err := s.Store.GetDoc(r.Context(), u.ID, in.BaseID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && b.Kind != "base") {
		httpx.Error(w, http.StatusNotFound, "not_found", "base not found")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if store.RoleRank(b.Role) < store.RoleRank(store.RoleView) {
		httpx.Error(w, http.StatusForbidden, "forbidden", "没有访问该多维表格的权限")
		return
	}
	if !store.DocumentCopyAllowed(b, b.Role) {
		httpx.Error(w, http.StatusForbidden, "copy_restricted", "该多维表格禁止复制内容，不能发送给 AI")
		return
	}

	switch in.Preset {
	case "summarize", "classify", "translate_en", "extract_keywords", "custom":
	default:
		httpx.Error(w, http.StatusBadRequest, "invalid_preset", "不支持的 AI 填充预设")
		return
	}
	customPrompt := strings.TrimSpace(truncateRunes(in.CustomPrompt, 1000))
	if in.Preset == "custom" && customPrompt == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_prompt", "自定义填充模式需要填写提示词")
		return
	}
	if len(in.Rows) == 0 {
		httpx.Error(w, http.StatusBadRequest, "empty_rows", "没有可填充的数据行")
		return
	}
	if len(in.Rows) > aiBaseFillMaxRows {
		httpx.Error(w, http.StatusBadRequest, "too_many_rows", fmt.Sprintf("单次批量填充最多支持 %d 行", aiBaseFillMaxRows))
		return
	}
	if !s.aiRate.allow(u.ID, s.now()) {
		httpx.Error(w, http.StatusTooManyRequests, "ai_rate_limited", "请求过于频繁，请稍后再试")
		return
	}

	cleanRows := make([]aiBaseFillRow, len(in.Rows))
	for i, row := range in.Rows {
		cleanRows[i] = aiBaseFillRow{
			RecordID: row.RecordID,
			Text:     strings.TrimSpace(truncateRunes(row.Text, 2000)),
		}
	}
	cleanOptions := make([]string, 0, len(in.Options))
	for _, opt := range in.Options {
		o := strings.TrimSpace(opt)
		if o != "" && !slices.Contains(cleanOptions, o) {
			cleanOptions = append(cleanOptions, o)
		}
	}

	w.Header().Set("Cache-Control", "no-store")
	if _, ready := s.configuredAIModel(r.Context(), u.ID); ready {
		llmResults, aiErr := s.runBaseFillLLM(r.Context(), u.ID, in.Preset, customPrompt, in.SourceFieldName, in.TargetFieldType, cleanOptions, cleanRows)
		if aiErr == nil && len(llmResults) == len(cleanRows) {
			httpx.JSON(w, http.StatusOK, aiBaseFillResp{
				Results: llmResults,
				Mode:    "llm",
			})
			return
		}
		if isBlockedAIError(aiErr) {
			s.aiError(w, r, aiErr)
			return
		}
	}

	results := make([]aiBaseFillResult, len(cleanRows))
	for i, row := range cleanRows {
		val := localBaseFillTransform(in.Preset, customPrompt, in.TargetFieldType, cleanOptions, row.Text)
		results[i] = aiBaseFillResult{RecordID: row.RecordID, Value: val}
	}
	httpx.JSON(w, http.StatusOK, aiBaseFillResp{
		Results: results,
		Mode:    "local",
	})
}

func (s *Server) runBaseFillLLM(
	ctx context.Context,
	userID int64,
	preset, customPrompt, sourceFieldName, targetFieldType string,
	options []string,
	rows []aiBaseFillRow,
) ([]aiBaseFillResult, error) {
	byID := make(map[int64]string, len(rows))
	for start := 0; start < len(rows); start += aiBaseFillBatchSize {
		end := min(start+aiBaseFillBatchSize, len(rows))
		batch := rows[start:end]
		msgs := buildBaseFillMessages(preset, customPrompt, sourceFieldName, targetFieldType, options, batch)
		raw, err := s.callAI(ctx, userID, msgs)
		if err != nil {
			return nil, err
		}
		parsed, ok := parseBaseFillLLMArray(raw)
		if !ok {
			return nil, errors.New("unparseable llm batch response")
		}
		for _, item := range parsed {
			byID[item.RecordID] = normalizeBaseFillValue(item.Value, targetFieldType, options, "")
		}
	}
	out := make([]aiBaseFillResult, len(rows))
	for i, row := range rows {
		val, ok := byID[row.RecordID]
		if !ok {
			val = localBaseFillTransform(preset, customPrompt, targetFieldType, options, row.Text)
		} else {
			val = normalizeBaseFillValue(val, targetFieldType, options, row.Text)
		}
		out[i] = aiBaseFillResult{RecordID: row.RecordID, Value: val}
	}
	return out, nil
}

func buildBaseFillMessages(preset, customPrompt, sourceFieldName, targetFieldType string, options []string, rows []aiBaseFillRow) []aiMessage {
	taskDesc := map[string]string{
		"summarize":        "将每行原文提炼为 15-35 字的简洁中文摘要",
		"classify":         "将每行原文归类到最匹配的标签",
		"translate_en":     "将每行原文准确翻译为简洁自然的英文",
		"extract_keywords": "从每行原文提取 2-4 个核心关键词，用顿号（、）分隔",
		"custom":           customPrompt,
	}[preset]

	var rules strings.Builder
	fmt.Fprintf(&rules, "你是多维表格批量 AI 列填充引擎。源字段为「%s」，目标字段类型为「%s」。任务：%s。\n", sourceFieldName, targetFieldType, taskDesc)
	if len(options) > 0 && (targetFieldType == "select" || targetFieldType == "multi_select") {
		if targetFieldType == "select" {
			fmt.Fprintf(&rules, "目标为单选字段，每行 value 必须严格从以下候选项中选择一个：%s。\n", strings.Join(options, " / "))
		} else {
			fmt.Fprintf(&rules, "目标为多选字段，每行 value 必须是以下候选项中 1-2 个并用英文逗号分隔：%s。\n", strings.Join(options, " / "))
		}
	}
	rules.WriteString(`请严格返回 JSON 数组，不要输出多余说明：[{"recordId": 1, "value": "..."}]`)

	payload, _ := json.Marshal(rows)
	return []aiMessage{
		{Role: "system", Content: rules.String()},
		{Role: "user", Content: string(payload)},
	}
}

func parseBaseFillLLMArray(raw string) ([]aiBaseFillResult, bool) {
	cleaned := stripCodeFence(raw)
	var direct []aiBaseFillResult
	if json.Unmarshal([]byte(cleaned), &direct) == nil && len(direct) > 0 {
		return direct, true
	}
	var wrapped struct {
		Results []aiBaseFillResult `json:"results"`
	}
	if json.Unmarshal([]byte(cleaned), &wrapped) == nil && len(wrapped.Results) > 0 {
		return wrapped.Results, true
	}
	if start, end := strings.Index(cleaned, "["), strings.LastIndex(cleaned, "]"); start >= 0 && end > start {
		if json.Unmarshal([]byte(cleaned[start:end+1]), &direct) == nil && len(direct) > 0 {
			return direct, true
		}
	}
	return nil, false
}

func normalizeBaseFillValue(val, targetFieldType string, options []string, sourceText string) string {
	val = strings.TrimSpace(val)
	if len(options) == 0 {
		return val
	}
	if targetFieldType == "select" {
		if slices.Contains(options, val) {
			return val
		}
		foldedVal := cases.Fold().String(val)
		for _, opt := range options {
			if cases.Fold().String(opt) == foldedVal {
				return opt
			}
		}
		for _, opt := range options {
			if strings.Contains(foldedVal, cases.Fold().String(opt)) {
				return opt
			}
		}
		return classifyIntoOptions(sourceText+" "+val, options, false)
	}
	if targetFieldType == "multi_select" {
		parts := strings.FieldsFunc(val, func(r rune) bool {
			return r == ',' || r == '，' || r == '、' || r == ';' || r == '；'
		})
		matched := make([]string, 0, len(parts))
		for _, p := range parts {
			fp := cases.Fold().String(strings.TrimSpace(p))
			if fp == "" {
				continue
			}
			for _, opt := range options {
				if cases.Fold().String(opt) == fp && !slices.Contains(matched, opt) {
					matched = append(matched, opt)
				}
			}
		}
		if len(matched) > 0 {
			return strings.Join(matched, ", ")
		}
		return classifyIntoOptions(sourceText+" "+val, options, true)
	}
	return val
}

var baseClassifySynonyms = []struct {
	optionHints []string
	textHints   []string
}{
	{[]string{"高", "紧急", "p0", "high", "urgent", "严重"}, []string{"紧急", "阻塞", "严重", "立刻", "马上", "故障", "崩溃", "宕机", "p0", "urgent", "critical", "blocker"}},
	{[]string{"中", "普通", "p1", "medium", "normal"}, []string{"优化", "跟进", "正常", "计划", "排期", "迭代", "p1", "medium", "normal"}},
	{[]string{"低", "p2", "low", "次要"}, []string{"建议", "后续", "微调", "有空", "长期", "p2", "low", "minor"}},
	{[]string{"已完成", "完成", "done", "closed", "已上线"}, []string{"完成", "上线", "发布", "解决", "通过", "归档", "done", "completed", "shipped", "resolved"}},
	{[]string{"进行中", "处理中", "in progress", "doing", "开发中"}, []string{"开发中", "处理中", "推进", "评审", "联调", "测试中", "progress", "working", "review"}},
	{[]string{"待办", "待处理", "未开始", "todo", "open"}, []string{"待处理", "未开始", "待办", "新建", "计划", "准备", "todo", "pending", "backlog"}},
	{[]string{"缺陷", "bug", "故障", "问题"}, []string{"报错", "失败", "异常", "崩溃", "bug", "error", "crash", "fix", "缺陷", "问题"}},
	{[]string{"需求", "功能", "feature", "enhancement"}, []string{"新增", "支持", "功能", "需求", "上线", "feature", "request", "add", "support"}},
	{[]string{"安全", "合规", "权限", "security"}, []string{"权限", "安全", "审计", "加密", "水印", "sso", "mfa", "security", "audit", "rbac"}},
	{[]string{"研发", "技术", "工程", "engineering", "tech"}, []string{"接口", "后端", "前端", "数据库", "性能", "架构", "api", "sql", "code"}},
	{[]string{"销售", "客户", "商务", "sales", "crm"}, []string{"客户", "合同", "报价", "回款", "商机", "签约", "sales", "deal", "customer"}},
}

func classifyIntoOptions(text string, options []string, multi bool) string {
	if len(options) == 0 {
		return inferDefaultCategory(text)
	}
	folded := cases.Fold().String(text)
	type scoredOpt struct {
		opt   string
		score float64
		idx   int
	}
	scored := make([]scoredOpt, len(options))
	for i, opt := range options {
		fopt := cases.Fold().String(opt)
		sc := 0.0
		if fopt != "" && strings.Contains(folded, fopt) {
			sc += 10.0
		}
		// Bigram overlap for Chinese options.
		rr := []rune(fopt)
		for k := 0; k+1 < len(rr); k++ {
			if strings.Contains(folded, string(rr[k:k+2])) {
				sc += 2.0
			}
		}
		// Synonym hints.
		for _, grp := range baseClassifySynonyms {
			optMatch := false
			for _, oh := range grp.optionHints {
				if strings.Contains(fopt, oh) {
					optMatch = true
					break
				}
			}
			if !optMatch {
				continue
			}
			for _, th := range grp.textHints {
				if strings.Contains(folded, th) {
					sc += 4.0
				}
			}
		}
		scored[i] = scoredOpt{opt: opt, score: sc, idx: i}
	}
	sort.Slice(scored, func(i, j int) bool {
		if scored[i].score != scored[j].score {
			return scored[i].score > scored[j].score
		}
		return scored[i].idx < scored[j].idx
	})
	if !multi {
		return scored[0].opt
	}
	picked := []string{scored[0].opt}
	if len(scored) > 1 && scored[1].score > 0 && scored[1].score >= scored[0].score*0.5 {
		picked = append(picked, scored[1].opt)
	}
	return strings.Join(picked, ", ")
}

func inferDefaultCategory(text string) string {
	f := cases.Fold().String(text)
	switch {
	case containsAny(f, "紧急", "故障", "崩溃", "阻塞", "urgent", "critical"):
		return "紧急事项"
	case containsAny(f, "报错", "异常", "失败", "bug", "error", "缺陷"):
		return "缺陷修复"
	case containsAny(f, "新增", "支持", "功能", "需求", "feature"):
		return "功能需求"
	case containsAny(f, "安全", "权限", "审计", "合规", "security", "rbac"):
		return "安全合规"
	case containsAny(f, "完成", "上线", "发布", "进展", "done", "shipped"):
		return "项目进展"
	default:
		return "常规记录"
	}
}

func extractiveSummarize(text string) string {
	clean := strings.Join(strings.Fields(text), " ")
	if clean == "" {
		return ""
	}
	if utf8.RuneCountInString(clean) <= 36 {
		return clean
	}
	// Take first complete sentence if within reasonable bounds.
	runes := []rune(clean)
	for i, r := range runes {
		if i >= 12 && i <= 44 && (r == '。' || r == '！' || r == '？' || r == '.' || r == ';' || r == '；') {
			return string(runes[:i+1])
		}
	}
	return string(runes[:35]) + "…"
}

func extractKeywordsLocal(text string) string {
	terms := extractQueryTerms(text)
	picked := make([]string, 0, 4)
	for _, term := range terms {
		if term.isBigram {
			continue
		}
		picked = append(picked, term.text)
		if len(picked) >= 4 {
			break
		}
	}
	if len(picked) == 0 {
		for _, term := range terms {
			picked = append(picked, term.text)
			if len(picked) >= 3 {
				break
			}
		}
	}
	if len(picked) == 0 {
		return truncateRunes(strings.TrimSpace(text), 20)
	}
	return strings.Join(picked, "、")
}

var enGlossary = [][2]string{
	{"高优先级", "High Priority"},
	{"中优先级", "Medium Priority"},
	{"低优先级", "Low Priority"},
	{"已完成", "Completed"},
	{"进行中", "In Progress"},
	{"待处理", "Pending"},
	{"待办", "To Do"},
	{"安全策略", "Security Policy"},
	{"权限配置", "Permission Settings"},
	{"权限", "Permission"},
	{"安全", "Security"},
	{"审批", "Approval"},
	{"风险", "Risk"},
	{"需求", "Requirement"},
	{"缺陷", "Bug"},
	{"优化", "Optimization"},
	{"发布", "Release"},
	{"上线", "Launch"},
	{"项目", "Project"},
	{"计划", "Plan"},
	{"进展", "Progress"},
	{"总结", "Summary"},
	{"报告", "Report"},
	{"客户", "Customer"},
	{"合同", "Contract"},
	{"金额", "Amount"},
	{"会议", "Meeting"},
	{"文档", "Document"},
	{"表格", "Table"},
	{"团队", "Team"},
	{"本周", "This week"},
	{"下周", "Next week"},
	{"紧急", "Urgent"},
	{"测试", "Testing"},
	{"设计", "Design"},
	{"开发", "Development"},
	{"完成", "Completed"},
}

func translateToEnglishLocal(text string) string {
	clean := strings.TrimSpace(text)
	if clean == "" {
		return ""
	}
	if isLikelyEnglish(clean) {
		return clean
	}
	out := clean
	replaced := 0
	for _, pair := range enGlossary {
		if strings.Contains(out, pair[0]) {
			out = strings.ReplaceAll(out, pair[0], " "+pair[1]+" ")
			replaced++
		}
	}
	out = strings.Join(strings.Fields(out), " ")
	if !isLikelyEnglish(out) {
		return "[EN] " + out
	}
	if replaced == 0 {
		return "[EN] " + clean
	}
	return out
}

func localBaseFillTransform(preset, customPrompt, targetFieldType string, options []string, text string) string {
	clean := strings.TrimSpace(text)
	if clean == "" {
		return ""
	}
	var result string
	switch preset {
	case "summarize":
		result = extractiveSummarize(clean)
	case "classify":
		result = classifyIntoOptions(clean, options, targetFieldType == "multi_select")
	case "extract_keywords":
		if len(options) > 0 && (targetFieldType == "select" || targetFieldType == "multi_select") {
			result = classifyIntoOptions(clean, options, targetFieldType == "multi_select")
		} else {
			result = extractKeywordsLocal(clean)
		}
	case "translate_en":
		result = translateToEnglishLocal(clean)
	case "custom":
		lp := cases.Fold().String(customPrompt)
		switch {
		case len(options) > 0 && (targetFieldType == "select" || targetFieldType == "multi_select"):
			result = classifyIntoOptions(clean+" "+customPrompt, options, targetFieldType == "multi_select")
		case containsAny(lp, "大写", "uppercase", "upper"):
			result = strings.ToUpper(clean)
		case containsAny(lp, "小写", "lowercase", "lower"):
			result = strings.ToLower(clean)
		case containsAny(lp, "翻译", "英文", "english", "translate"):
			result = translateToEnglishLocal(clean)
		case containsAny(lp, "关键词", "标签", "keyword", "tag"):
			result = extractKeywordsLocal(clean)
		case containsAny(lp, "字数", "长度", "count", "length"):
			result = fmt.Sprintf("%s（%d字）", extractiveSummarize(clean), utf8.RuneCountInString(clean))
		default:
			result = extractiveSummarize(clean)
		}
	default:
		result = extractiveSummarize(clean)
	}
	return normalizeBaseFillValue(result, targetFieldType, options, clean)
}
