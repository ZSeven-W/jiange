package api

import (
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func (s *Server) surveyStore(w http.ResponseWriter) (store.SurveyStore, bool) {
	st, ok := s.Store.(store.SurveyStore)
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "unavailable", "独立问卷服务暂不可用")
		return nil, false
	}
	return st, true
}

func validateSurveyQuestions(qs []store.SurveyQuestion) string {
	if len(qs) > 100 {
		return "单个问卷最多支持 100 道题目"
	}
	seen := make(map[string]bool, len(qs))
	for _, q := range qs {
		if q.ID == "" || len(q.ID) > 64 || seen[q.ID] {
			return "题目 ID 无效或重复"
		}
		seen[q.ID] = true
		switch q.Type {
		case "single", "multi", "text", "rating", "matrix", "ranking", "signature", "file":
		default:
			return "不支持的题型：" + q.Type
		}
		if utf8.RuneCountInString(q.Title) > 500 || utf8.RuneCountInString(q.Description) > 2000 {
			return "题干或说明超出长度限制"
		}
		if (q.Type == "single" || q.Type == "multi" || q.Type == "ranking") && len(q.Options) == 0 {
			return "选择题与排序题至少需要 1 个选项"
		}
		if q.Type == "matrix" && (len(q.MatrixRows) == 0 || len(q.MatrixCols) == 0) {
			return "矩阵题需要至少 1 行和 1 列"
		}
		if q.Type == "rating" && (q.MaxRating < 2 || q.MaxRating > 10) {
			return "评分题分值范围需在 2 至 10 之间"
		}
	}
	for _, q := range qs {
		for _, rule := range q.SkipRules {
			if rule.JumpToQuestionID != "__END__" && !seen[rule.JumpToQuestionID] {
				return "跳题规则指向不存在的目标题目"
			}
		}
	}
	return ""
}

// evaluateVisibleSurveyQuestions computes the ordered set of visible question
// IDs given the current answers, evaluating forward skip rules cleanly.
func evaluateVisibleSurveyQuestions(qs []store.SurveyQuestion, answers map[string]any) map[string]bool {
	indexByID := make(map[string]int, len(qs))
	for i, q := range qs {
		indexByID[q.ID] = i
	}
	visible := make(map[string]bool, len(qs))
	for i := 0; i < len(qs); {
		q := qs[i]
		visible[q.ID] = true
		next := i + 1
		if len(q.SkipRules) > 0 {
			ans := answers[q.ID]
			selected := map[string]bool{}
			switch v := ans.(type) {
			case string:
				if v != "" {
					selected[v] = true
				}
			case []any:
				for _, item := range v {
					if str, ok := item.(string); ok && str != "" {
						selected[str] = true
					}
				}
			}
			for _, rule := range q.SkipRules {
				if selected[rule.WhenOption] {
					if rule.JumpToQuestionID == "__END__" {
						next = len(qs)
					} else if targetIdx, ok := indexByID[rule.JumpToQuestionID]; ok && targetIdx > i {
						next = targetIdx
					}
					break
				}
			}
		}
		i = next
	}
	return visible
}

func isAnswerFilled(q store.SurveyQuestion, raw any) bool {
	if raw == nil {
		return false
	}
	switch q.Type {
	case "single", "text", "signature":
		s, ok := raw.(string)
		return ok && strings.TrimSpace(s) != ""
	case "multi", "ranking":
		arr, ok := raw.([]any)
		return ok && len(arr) > 0
	case "rating":
		n, ok := raw.(float64)
		return ok && n >= 1
	case "matrix":
		m, ok := raw.(map[string]any)
		if !ok || len(m) == 0 {
			return false
		}
		for _, r := range q.MatrixRows {
			v, exists := m[r]
			if !exists {
				return false
			}
			s, ok := v.(string)
			if !ok || strings.TrimSpace(s) == "" {
				return false
			}
		}
		return true
	case "file":
		m, ok := raw.(map[string]any)
		return ok && len(m) > 0
	default:
		return false
	}
}

func (s *Server) getSurvey(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleView)
	if !ok {
		return
	}
	if d.Kind != "survey" {
		httpx.Error(w, http.StatusNotFound, "not_found", "问卷不存在")
		return
	}
	st, ok := s.surveyStore(w)
	if !ok {
		return
	}
	sv, err := st.GetSurvey(r.Context(), d.ID)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "问卷不存在")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	resps, err := st.ListSurveyResponses(r.Context(), d.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"survey":        sv,
		"title":         d.Title,
		"role":          d.Role,
		"responseCount": len(resps),
	})
}

func (s *Server) saveSurvey(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleEdit)
	if !ok {
		return
	}
	if d.Kind != "survey" {
		httpx.Error(w, http.StatusNotFound, "not_found", "问卷不存在")
		return
	}
	st, ok := s.surveyStore(w)
	if !ok {
		return
	}
	var in struct {
		Description      string                 `json:"description"`
		Questions        []store.SurveyQuestion `json:"questions"`
		AllowAnonymous   *bool                  `json:"allowAnonymous"`
		MaxResponses     *int                   `json:"maxResponses"`
		ExpectedRevision int64                  `json:"expectedRevision"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if utf8.RuneCountInString(in.Description) > 4000 {
		httpx.Error(w, http.StatusBadRequest, "invalid_description", "问卷说明不能超过 4000 字")
		return
	}
	if msg := validateSurveyQuestions(in.Questions); msg != "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_questions", msg)
		return
	}
	updated, err := st.SaveSurvey(r.Context(), d.ID, store.SurveyUpdate{
		Description:      strings.TrimSpace(in.Description),
		Questions:        in.Questions,
		AllowAnonymous:   in.AllowAnonymous,
		MaxResponses:     in.MaxResponses,
		ExpectedRevision: in.ExpectedRevision,
	})
	if errors.Is(err, store.ErrConflict) {
		httpx.Error(w, http.StatusConflict, "revision_conflict", "问卷已在别处更新，请刷新后重试")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"survey": updated})
}

func (s *Server) setSurveyStatus(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleEdit)
	if !ok {
		return
	}
	if d.Kind != "survey" {
		httpx.Error(w, http.StatusNotFound, "not_found", "问卷不存在")
		return
	}
	st, ok := s.surveyStore(w)
	if !ok {
		return
	}
	var in struct {
		Status         string `json:"status"`
		AllowAnonymous *bool  `json:"allowAnonymous"`
		MaxResponses   *int   `json:"maxResponses"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.Status != "draft" && in.Status != "published" && in.Status != "closed" {
		httpx.Error(w, http.StatusBadRequest, "invalid_status", "无效的问卷状态")
		return
	}
	updated, err := st.SetSurveyStatus(r.Context(), d.ID, in.Status, in.AllowAnonymous, in.MaxResponses)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"survey": updated})
}

type surveyQuestionStat struct {
	QuestionID   string                    `json:"questionId"`
	Title        string                    `json:"title"`
	Type         string                    `json:"type"`
	Answered     int                       `json:"answered"`
	OptionCounts map[string]int            `json:"optionCounts,omitempty"`
	Average      float64                   `json:"average,omitempty"`
	RatingDist   map[string]int            `json:"ratingDist,omitempty"`
	MatrixCounts map[string]map[string]int `json:"matrixCounts,omitempty"`
	RankAvg      map[string]float64        `json:"rankAvg,omitempty"`
	TextSamples  []string                  `json:"textSamples,omitempty"`
}

func (s *Server) getSurveyStats(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleView)
	if !ok {
		return
	}
	if d.Kind != "survey" {
		httpx.Error(w, http.StatusNotFound, "not_found", "问卷不存在")
		return
	}
	st, ok := s.surveyStore(w)
	if !ok {
		return
	}
	sv, err := st.GetSurvey(r.Context(), d.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	resps, err := st.ListSurveyResponses(r.Context(), d.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	parsed := make([]map[string]any, len(resps))
	for i, resp := range resps {
		var m map[string]any
		_ = json.Unmarshal(resp.Answers, &m)
		parsed[i] = m
	}

	stats := make([]surveyQuestionStat, 0, len(sv.Questions))
	for _, q := range sv.Questions {
		qs := surveyQuestionStat{QuestionID: q.ID, Title: q.Title, Type: q.Type}
		switch q.Type {
		case "single", "multi":
			qs.OptionCounts = make(map[string]int, len(q.Options))
			for _, opt := range q.Options {
				qs.OptionCounts[opt] = 0
			}
			for _, ans := range parsed {
				v := ans[q.ID]
				if q.Type == "single" {
					if str, ok := v.(string); ok && str != "" {
						qs.Answered++
						qs.OptionCounts[str]++
					}
				} else if arr, ok := v.([]any); ok && len(arr) > 0 {
					qs.Answered++
					for _, item := range arr {
						if str, ok := item.(string); ok && str != "" {
							qs.OptionCounts[str]++
						}
					}
				}
			}
		case "rating":
			qs.RatingDist = map[string]int{}
			var sum float64
			for _, ans := range parsed {
				if n, ok := ans[q.ID].(float64); ok && n >= 1 {
					qs.Answered++
					sum += n
					k := strings.TrimSuffix(strings.TrimSuffix(jsonNumber(n), ".0"), ".")
					qs.RatingDist[k]++
				}
			}
			if qs.Answered > 0 {
				qs.Average = math.Round((sum/float64(qs.Answered))*100) / 100
			}
		case "matrix":
			qs.MatrixCounts = make(map[string]map[string]int, len(q.MatrixRows))
			for _, row := range q.MatrixRows {
				qs.MatrixCounts[row] = make(map[string]int, len(q.MatrixCols))
				for _, col := range q.MatrixCols {
					qs.MatrixCounts[row][col] = 0
				}
			}
			for _, ans := range parsed {
				if m, ok := ans[q.ID].(map[string]any); ok && len(m) > 0 {
					qs.Answered++
					for _, row := range q.MatrixRows {
						if col, ok := m[row].(string); ok && col != "" {
							qs.MatrixCounts[row][col]++
						}
					}
				}
			}
		case "ranking":
			rankSum := map[string]float64{}
			rankCnt := map[string]int{}
			for _, opt := range q.Options {
				rankSum[opt] = 0
				rankCnt[opt] = 0
			}
			for _, ans := range parsed {
				if arr, ok := ans[q.ID].([]any); ok && len(arr) > 0 {
					qs.Answered++
					for idx, item := range arr {
						if opt, ok := item.(string); ok && opt != "" {
							rankSum[opt] += float64(idx + 1)
							rankCnt[opt]++
						}
					}
				}
			}
			qs.RankAvg = map[string]float64{}
			keys := make([]string, 0, len(rankCnt))
			for k := range rankCnt {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				if rankCnt[k] > 0 {
					qs.RankAvg[k] = math.Round((rankSum[k]/float64(rankCnt[k]))*100) / 100
				}
			}
		default: // text, signature, file
			for _, ans := range parsed {
				v := ans[q.ID]
				if isAnswerFilled(q, v) {
					qs.Answered++
					if s, ok := v.(string); ok && len(qs.TextSamples) < 50 {
						qs.TextSamples = append(qs.TextSamples, s)
					}
				}
			}
		}
		stats = append(stats, qs)
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"totalResponses": len(resps),
		"questionStats":  stats,
		"responses":      resps,
	})
}

func jsonNumber(n float64) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func (s *Server) getPublicSurvey(w http.ResponseWriter, r *http.Request) {
	st, ok := s.surveyStore(w)
	if !ok {
		return
	}
	token := strings.TrimSpace(r.PathValue("token"))
	if token == "" {
		httpx.Error(w, http.StatusNotFound, "not_found", "问卷不存在")
		return
	}
	sv, meta, err := st.GetSurveyByToken(r.Context(), token)
	if errors.Is(err, store.ErrNotFound) || sv.Status == "draft" {
		httpx.Error(w, http.StatusNotFound, "not_found", "问卷未发布或不存在")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if sv.Status == "closed" {
		httpx.Error(w, http.StatusGone, "survey_closed", "该问卷已停止收集")
		return
	}
	resps, _ := st.ListSurveyResponses(r.Context(), sv.NodeID)
	full := sv.MaxResponses > 0 && len(resps) >= sv.MaxResponses
	httpx.JSON(w, http.StatusOK, map[string]any{
		"title":          meta.Title,
		"description":    sv.Description,
		"allowAnonymous": sv.AllowAnonymous,
		"maxResponses":   sv.MaxResponses,
		"responseCount":  len(resps),
		"full":           full,
		"questions":      sv.Questions,
	})
}

func (s *Server) submitPublicSurvey(w http.ResponseWriter, r *http.Request) {
	st, ok := s.surveyStore(w)
	if !ok {
		return
	}
	token := strings.TrimSpace(r.PathValue("token"))
	sv, _, err := st.GetSurveyByToken(r.Context(), token)
	if errors.Is(err, store.ErrNotFound) || sv.Status == "draft" {
		httpx.Error(w, http.StatusNotFound, "not_found", "问卷未发布或不存在")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if sv.Status == "closed" {
		httpx.Error(w, http.StatusGone, "survey_closed", "该问卷已停止收集")
		return
	}
	var respondentID *int64
	respondentName := "匿名填写者"
	if u, ok := UserFrom(r.Context()); ok {
		uid := u.ID
		respondentID = &uid
		respondentName = u.Name
	} else if !sv.AllowAnonymous {
		httpx.Error(w, http.StatusUnauthorized, "login_required", "该问卷需要登录后填写")
		return
	}

	var in struct {
		RespondentName string         `json:"respondentName"`
		Answers        map[string]any `json:"answers"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.RespondentName) != "" && utf8.RuneCountInString(in.RespondentName) <= 80 {
		respondentName = strings.TrimSpace(in.RespondentName)
	}
	if in.Answers == nil {
		in.Answers = map[string]any{}
	}
	// Evaluate skip logic server-side so skipped required questions do not block submission.
	visible := evaluateVisibleSurveyQuestions(sv.Questions, in.Answers)
	for _, q := range sv.Questions {
		if visible[q.ID] && q.Required && !isAnswerFilled(q, in.Answers[q.ID]) {
			httpx.Error(w, http.StatusBadRequest, "missing_required", "请填写必填题："+q.Title)
			return
		}
	}
	rawAns, err := json.Marshal(in.Answers)
	if err != nil || len(rawAns) > 1<<20 {
		httpx.Error(w, http.StatusBadRequest, "invalid_answers", "答卷内容无效或超过大小限制")
		return
	}
	created, err := st.SubmitSurveyResponse(r.Context(), sv.NodeID, respondentID, respondentName, rawAns)
	if errors.Is(err, store.ErrConflict) {
		httpx.Error(w, http.StatusConflict, "survey_full_or_closed", "问卷已满额或已停止收集")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"response": created})
}
