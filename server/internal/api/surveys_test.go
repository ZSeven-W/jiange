package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestStandaloneSurveyFullLifecycleSkipLogicAndStats(t *testing.T) {
	st := store.NewMemory()
	s := &Server{
		Store:      st,
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		SessionTTL: time.Hour,
		Iterations: 1000,
	}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	jar, _ := cookiejar.New(nil)
	owner := &http.Client{Jar: jar}
	anon := &http.Client{}

	doJSON := func(c *http.Client, method, path string, body any) (*http.Response, []byte) {
		t.Helper()
		var reader io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			reader = bytes.NewReader(b)
		}
		req, err := http.NewRequest(method, ts.URL+path, reader)
		if err != nil {
			t.Fatal(err)
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp, raw
	}

	resp, raw := doJSON(owner, "POST", "/api/auth/register", map[string]any{
		"email": "survey@test.io", "name": "SurveyAdmin", "password": "password123",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register: %d %s", resp.StatusCode, raw)
	}

	// 1. Create a standalone `kind="survey"` node via Drive API.
	resp, raw = doJSON(owner, "POST", "/api/drive/nodes", map[string]any{
		"kind": "survey", "title": "2026 Q4 客户满意度调研", "scope": "workspace",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create survey node: %d %s", resp.StatusCode, raw)
	}
	var entry struct {
		ID   int64  `json:"id"`
		Kind string `json:"kind"`
	}
	_ = json.Unmarshal(raw, &entry)
	if entry.Kind != "survey" {
		t.Fatalf("expected kind=survey, got %q", entry.Kind)
	}

	// 2. Design rich questions: single (with skip logic), required text (skipped when q1=="跳过"), matrix, ranking, rating, signature.
	questions := []store.SurveyQuestion{
		{
			ID: "q1", Type: "single", Title: "是否使用过云文档？", Required: true,
			Options:   []string{"深度使用", "未使用"},
			SkipRules: []store.SurveySkipRule{{WhenOption: "未使用", JumpToQuestionID: "q_sig"}},
		},
		{ID: "q_detail", Type: "text", Title: "最常用功能（未使用者自动跳过）", Required: true},
		{ID: "q_rate", Type: "rating", Title: "总体满意度评分", Required: true, MaxRating: 5},
		{
			ID: "q_matrix", Type: "matrix", Title: "各模块体验评价", Required: false,
			MatrixRows: []string{"文档", "表格"},
			MatrixCols: []string{"优秀", "良好"},
		},
		{
			ID: "q_rank", Type: "ranking", Title: "需求优先级排序", Required: false,
			Options: []string{"协作速度", "排版能力", "导出保真"},
		},
		{ID: "q_sig", Type: "signature", Title: "受访者确认签名", Required: true},
	}
	resp, raw = doJSON(owner, "PUT", fmt.Sprintf("/api/surveys/%d", entry.ID), map[string]any{
		"description":      "用于评估产品迭代重点",
		"questions":        questions,
		"allowAnonymous":   true,
		"maxResponses":     2,
		"expectedRevision": 1,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("save survey: %d %s", resp.StatusCode, raw)
	}

	// 3. Publish survey -> mints publicToken.
	resp, raw = doJSON(owner, "POST", fmt.Sprintf("/api/surveys/%d/status", entry.ID), map[string]any{
		"status": "published",
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("publish survey: %d %s", resp.StatusCode, raw)
	}
	var pubRes struct {
		Survey store.Survey `json:"survey"`
	}
	_ = json.Unmarshal(raw, &pubRes)
	token := pubRes.Survey.PublicToken
	if token == "" || pubRes.Survey.Status != "published" {
		t.Fatalf("unexpected publish result: %+v", pubRes.Survey)
	}

	// 4. Anonymous respondent #1 triggers skip logic ("未使用" -> jumps directly to q_sig, skipping required q_detail & q_rate!).
	resp, raw = doJSON(anon, "POST", "/api/public/surveys/"+token+"/submit", map[string]any{
		"respondentName": "访客甲",
		"answers": map[string]any{
			"q1":    "未使用",
			"q_sig": "data:image/png;base64,iVBORw0KGgo=",
		},
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("anon skip-logic submit failed: %d %s", resp.StatusCode, raw)
	}

	// 5. Anonymous respondent #2 submits full answers (hits maxResponses == 2).
	resp, raw = doJSON(anon, "POST", "/api/public/surveys/"+token+"/submit", map[string]any{
		"respondentName": "访客乙",
		"answers": map[string]any{
			"q1":       "深度使用",
			"q_detail": "多人协同表格",
			"q_rate":   5,
			"q_matrix": map[string]any{"文档": "优秀", "表格": "良好"},
			"q_rank":   []string{"协作速度", "导出保真", "排版能力"},
			"q_sig":    "data:image/png;base64,iVBORw0KGgo=",
		},
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("anon full submit failed: %d %s", resp.StatusCode, raw)
	}

	// 6. Respondent #3 rejected with 409 because maxResponses == 2 reached!
	resp, _ = doJSON(anon, "POST", "/api/public/surveys/"+token+"/submit", map[string]any{
		"answers": map[string]any{"q1": "未使用", "q_sig": "data:image/png;base64,abc"},
	})
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("max responses cap want 409 got %d", resp.StatusCode)
	}

	// 7. Verify server-aggregated stats!
	resp, raw = doJSON(owner, "GET", fmt.Sprintf("/api/surveys/%d/stats", entry.ID), nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get stats: %d %s", resp.StatusCode, raw)
	}
	var stats struct {
		TotalResponses int                  `json:"totalResponses"`
		QuestionStats  []surveyQuestionStat `json:"questionStats"`
	}
	_ = json.Unmarshal(raw, &stats)
	if stats.TotalResponses != 2 || len(stats.QuestionStats) != 6 {
		t.Fatalf("unexpected stats: %+v", stats)
	}
	if stats.QuestionStats[0].OptionCounts["深度使用"] != 1 || stats.QuestionStats[0].OptionCounts["未使用"] != 1 {
		t.Fatalf("unexpected q1 option counts: %+v", stats.QuestionStats[0].OptionCounts)
	}
	if stats.QuestionStats[2].Average != 5 {
		t.Fatalf("expected rating avg 5, got %v", stats.QuestionStats[2].Average)
	}
	if stats.QuestionStats[3].MatrixCounts["文档"]["优秀"] != 1 {
		t.Fatalf("unexpected matrix counts: %+v", stats.QuestionStats[3].MatrixCounts)
	}
	if stats.QuestionStats[4].RankAvg["协作速度"] != 1 || stats.QuestionStats[4].RankAvg["导出保真"] != 2 {
		t.Fatalf("unexpected ranking avg: %+v", stats.QuestionStats[4].RankAvg)
	}

	// 8. Close survey -> public GET returns 410 Gone.
	resp, raw = doJSON(owner, "POST", fmt.Sprintf("/api/surveys/%d/status", entry.ID), map[string]any{
		"status": "closed",
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("close survey: %d %s", resp.StatusCode, raw)
	}
	resp, _ = doJSON(anon, "GET", "/api/public/surveys/"+token, nil)
	if resp.StatusCode != http.StatusGone {
		t.Fatalf("closed public survey want 410 got %d", resp.StatusCode)
	}
}
