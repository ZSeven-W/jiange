package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/btquery"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type automationConfig struct {
	Rules       []btquery.Rule `json:"rules,omitempty"`
	Conj        string         `json:"conj,omitempty"`
	NotifyUsers []int64        `json:"notifyUsers"`
	Message     string         `json:"message,omitempty"`
	// Webhook 推送到 IM 群机器人或自建入口（可选）。
	Webhook automationWebhook `json:"webhook,omitempty"`
}

type automationWebhook struct {
	URL     string `json:"url,omitempty"`
	Kind    string `json:"kind,omitempty"` // wecom | dingtalk | feishu | generic
	Message string `json:"message,omitempty"`
}

type automationInput struct {
	Name        *string          `json:"name"`
	Enabled     *bool            `json:"enabled"`
	TriggerKind *string          `json:"triggerKind"`
	Config      *json.RawMessage `json:"config"`
}

var automationTriggers = map[string]bool{"form_submit": true, "record_matches": true}

func (in automationInput) apply(w http.ResponseWriter, a *store.Automation) bool {
	if in.Name != nil {
		n := strings.TrimSpace(*in.Name)
		if utf8.RuneCountInString(n) == 0 || utf8.RuneCountInString(n) > 100 {
			httpx.Error(w, http.StatusBadRequest, "invalid_name", "名称需要 1-100 字")
			return false
		}
		a.Name = n
	}
	if in.Enabled != nil {
		a.Enabled = *in.Enabled
	}
	if in.TriggerKind != nil {
		if !automationTriggers[*in.TriggerKind] {
			httpx.Error(w, http.StatusBadRequest, "invalid_trigger", "触发器必须是 form_submit 或 record_matches")
			return false
		}
		a.TriggerKind = *in.TriggerKind
	}
	if in.Config != nil {
		var cfg automationConfig
		if json.Unmarshal(*in.Config, &cfg) != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid_config", "配置格式错误")
			return false
		}
		if cfg.Conj != "" && cfg.Conj != "and" && cfg.Conj != "or" {
			httpx.Error(w, http.StatusBadRequest, "invalid_config", "conj 必须是 and/or")
			return false
		}
		for _, r := range cfg.Rules {
			if !btquery.OpsValid(r.Op) {
				httpx.Error(w, http.StatusBadRequest, "invalid_config", "未知操作 "+r.Op)
				return false
			}
		}
		if len(cfg.NotifyUsers) > 20 {
			httpx.Error(w, http.StatusBadRequest, "invalid_config", "最多通知 20 人")
			return false
		}
		if utf8.RuneCountInString(cfg.Message) > 500 {
			httpx.Error(w, http.StatusBadRequest, "invalid_config", "消息最长 500 字")
			return false
		}
		if cfg.Webhook.URL != "" {
			if !strings.HasPrefix(cfg.Webhook.URL, "http://") && !strings.HasPrefix(cfg.Webhook.URL, "https://") {
				httpx.Error(w, http.StatusBadRequest, "invalid_config", "webhook 地址必须是 http(s)")
				return false
			}
			switch cfg.Webhook.Kind {
			case "wecom", "dingtalk", "feishu", "generic", "":
			default:
				httpx.Error(w, http.StatusBadRequest, "invalid_config", "webhook kind 必须是 wecom/dingtalk/feishu/generic")
				return false
			}
			if utf8.RuneCountInString(cfg.Webhook.Message) > 500 {
				httpx.Error(w, http.StatusBadRequest, "invalid_config", "webhook 消息最长 500 字")
				return false
			}
		}
		a.Config = *in.Config
	}
	return true
}

func (s *Server) listAutomations(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleView)
	if !ok {
		return
	}
	as, err := s.Store.Automations(r.Context(), b.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if as == nil {
		as = []store.Automation{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"automations": as})
}

func (s *Server) addAutomation(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
		return
	}
	var in automationInput
	if !httpx.Decode(w, r, &in) {
		return
	}
	a := store.Automation{BaseID: b.ID, Name: "自动化流程", Enabled: true, TriggerKind: "record_matches"}
	if !in.apply(w, &a) {
		return
	}
	a, err := s.Store.AddAutomation(r.Context(), a)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, a)
}

func (s *Server) patchAutomation(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
		return
	}
	as, err := s.Store.Automations(r.Context(), b.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	var cur *store.Automation
	for i := range as {
		if as[i].ID == pathID(r, "aid") {
			cur = &as[i]
			break
		}
	}
	if cur == nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "automation not found")
		return
	}
	var in automationInput
	if !httpx.Decode(w, r, &in) {
		return
	}
	a := *cur
	if !in.apply(w, &a) {
		return
	}
	if a, err = s.Store.UpdateAutomation(r.Context(), a); err != nil {
		s.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, a)
}

func (s *Server) deleteAutomation(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
		return
	}
	if err := s.Store.DeleteAutomation(r.Context(), b.ID, pathID(r, "aid")); err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- execution ----

var tmplVar = regexp.MustCompile(`\{\{([^}]+)\}\}`)

// runAutomations evaluates enabled automations of the given trigger for one
// record: in-app notifications plus optional webhook pushes (企微/钉钉/飞书/
// generic). Called synchronously after the write; failures log and continue.
func (s *Server) runAutomations(ctx context.Context, baseID int64, trigger string, rec store.Record) {
	asis, err := s.Store.Automations(ctx, baseID)
	if err != nil {
		s.Log.Error("automations load", "err", err)
		return
	}
	if len(asis) == 0 {
		return
	}
	fields, err := s.Store.Fields(ctx, baseID)
	if err != nil {
		s.Log.Error("automations fields", "err", err)
		return
	}
	specs := store.Specs(fields)
	var actor store.User // 匿名表单提交时无用户
	if u, ok := UserFrom(ctx); ok {
		actor = u
	}
	for _, a := range asis {
		if !a.Enabled || a.TriggerKind != trigger {
			continue
		}
		var cfg automationConfig
		if json.Unmarshal(a.Config, &cfg) != nil {
			continue
		}
		if trigger == "record_matches" && len(cfg.Rules) > 0 {
			conj := cfg.Conj
			if conj == "" {
				conj = "and"
			}
			if !btquery.MatchRules(specs, cfg.Rules, conj, rec.Cells) {
				continue
			}
		}
		items := make([]store.Notification, 0, len(cfg.NotifyUsers))
		commentID := rec.ID // 关联到记录（通知面板用它跳转）
		for _, uid := range cfg.NotifyUsers {
			if actor.ID != 0 && uid == actor.ID {
				continue
			}
			items = append(items, store.Notification{
				UserID: uid, DocID: baseID, ActorID: actorIDOrZero(actor),
				CommentID: &commentID, Kind: "mention",
				Preview: renderTemplate(cfg.Message, fields, rec),
			})
		}
		if len(items) > 0 {
			if err := s.Store.AddNotifications(ctx, items); err != nil {
				s.Log.Error("automations notify", "err", err)
			}
		}
		if cfg.Webhook.URL != "" {
			s.pushWebhook(ctx, cfg.Webhook, renderTemplate(cfg.Webhook.Message, fields, rec))
		}
	}
}

// pushWebhook posts the rendered message in the target IM's robot payload
// format. 5s timeout, failures logged only.
func (s *Server) pushWebhook(ctx context.Context, wh automationWebhook, text string) {
	if strings.TrimSpace(text) == "" {
		return
	}
	var payload any
	switch wh.Kind {
	case "wecom":
		payload = map[string]any{"msgtype": "text", "text": map[string]string{"content": text}}
	case "dingtalk":
		payload = map[string]any{"msgtype": "text", "text": map[string]string{"content": text}}
	case "feishu":
		payload = map[string]any{"msg_type": "text", "content": map[string]string{"text": text}}
	default: // generic：自建 IM 收标准 JSON
		payload = map[string]any{"text": text}
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, wh.URL, bytes.NewReader(b))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		s.Log.Error("automation webhook", "url", wh.URL, "err", err)
		return
	}
	res.Body.Close()
	if res.StatusCode >= 300 {
		s.Log.Error("automation webhook", "url", wh.URL, "status", res.StatusCode)
	}
}

func actorIDOrZero(u store.User) int64 {
	if u.ID == 0 {
		return 0
	}
	return u.ID
}

// renderTemplate interpolates {{字段名}} from the record's cells.
func renderTemplate(tmpl string, fields []store.Field, rec store.Record) string {
	preview := snippet(tmpl)
	return tmplVar.ReplaceAllStringFunc(preview, func(m string) string {
		name := tmplVar.FindStringSubmatch(m)[1]
		for _, f := range fields {
			if f.Name != name {
				continue
			}
			if raw, ok := rec.Cells[strconv.FormatInt(f.ID, 10)]; ok {
				var v any
				if json.Unmarshal(raw, &v) == nil {
					switch x := v.(type) {
					case string:
						return x
					case float64:
						return strconv.FormatFloat(x, 'f', -1, 64)
					case bool:
						return strconv.FormatBool(x)
					}
				}
			}
			return ""
		}
		return m
	})
}
