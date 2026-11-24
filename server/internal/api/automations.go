package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
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

const (
	maxAutomationActions      = 10
	maxAutomationIfDepth      = 2
	maxAutomationFindLimit    = 50
	defaultAutomationFindRows = 20
	maxAutomationDepth        = 3
)

type automationDepthKeyType struct{}

var automationDepthKey = automationDepthKeyType{}

func automationDepth(ctx context.Context) int {
	if d, ok := ctx.Value(automationDepthKey).(int); ok {
		return d
	}
	return 0
}

func withNextAutomationDepth(ctx context.Context) context.Context {
	return context.WithValue(ctx, automationDepthKey, automationDepth(ctx)+1)
}

type automationAction struct {
	ID          string             `json:"id,omitempty"`
	Type        string             `json:"type"` // create_record | update_record | find_records | if_condition | notify | webhook
	TableID     *int64             `json:"tableId,omitempty"`
	Cells       map[string]any     `json:"cells,omitempty"`       // fieldId -> value/template string (supports {{field:<id>}}, {{record.id}}, {{base.title}})
	Conj        string             `json:"conj,omitempty"`        // for find_records / if_condition ("and" | "or")
	Rules       []btquery.Rule     `json:"rules,omitempty"`       // for find_records / if_condition
	Limit       int                `json:"limit,omitempty"`       // for find_records (default 20, max 50)
	TargetScope string             `json:"targetScope,omitempty"` // for update_record: "trigger" (default) | "found"
	ThenActions []automationAction `json:"thenActions,omitempty"` // for if_condition
	ElseActions []automationAction `json:"elseActions,omitempty"` // for if_condition
	NotifyUsers []int64            `json:"notifyUsers,omitempty"` // for notify
	Message     string             `json:"message,omitempty"`     // for notify/webhook
	Webhook     *automationWebhook `json:"webhook,omitempty"`     // for webhook
}

type automationConfig struct {
	Rules       []btquery.Rule `json:"rules,omitempty"`
	Conj        string         `json:"conj,omitempty"`
	NotifyUsers []int64        `json:"notifyUsers,omitempty"`
	Message     string         `json:"message,omitempty"`
	// Webhook 推送到 IM 群机器人或自建入口（可选）。
	Webhook automationWebhook `json:"webhook,omitempty"`
	// Schedule drives triggerKind=schedule: fire every interval (1h/1d/1w),
	// optionally only when rules match at least one record.
	Schedule *automationSchedule `json:"schedule,omitempty"`
	// Actions defines ordered read/write/branch/notification workflow steps.
	Actions []automationAction `json:"actions,omitempty"`
}

type automationSchedule struct {
	Every string `json:"every,omitempty"` // 1h | 1d | 1w
}

var scheduleEvery = map[string]bool{"1h": true, "1d": true, "1w": true}

// scheduleGap is the minimum spacing between firings per Every value.
func scheduleGap(every string) time.Duration {
	switch every {
	case "1h":
		return time.Hour
	case "1w":
		return 7 * 24 * time.Hour
	default:
		return 24 * time.Hour
	}
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

var automationTriggers = map[string]bool{"form_submit": true, "record_matches": true, "schedule": true}

func validateWebhookConfig(wh automationWebhook, fallbackMessage string) string {
	if !strings.HasPrefix(wh.URL, "http://") && !strings.HasPrefix(wh.URL, "https://") {
		return "webhook 地址必须是 http(s)"
	}
	switch wh.Kind {
	case "wecom", "dingtalk", "feishu", "generic", "":
	default:
		return "webhook kind 必须是 wecom/dingtalk/feishu/generic"
	}
	if utf8.RuneCountInString(wh.Message) > 500 || utf8.RuneCountInString(fallbackMessage) > 500 {
		return "webhook 消息最长 500 字"
	}
	return ""
}

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
			httpx.Error(w, http.StatusBadRequest, "invalid_trigger", "触发器必须是 form_submit、record_matches 或 schedule")
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
		if a.TriggerKind == "schedule" {
			if cfg.Schedule == nil || !scheduleEvery[cfg.Schedule.Every] {
				httpx.Error(w, http.StatusBadRequest, "invalid_config", "定时触发需要 schedule.every = 1h/1d/1w")
				return false
			}
		}
		if cfg.Webhook.URL != "" {
			if msg := validateWebhookConfig(cfg.Webhook, ""); msg != "" {
				httpx.Error(w, http.StatusBadRequest, "invalid_config", msg)
				return false
			}
		}
		a.Config = *in.Config
	}
	return true
}

func (s *Server) validateAutomationActions(w http.ResponseWriter, r *http.Request, baseID int64, a store.Automation) bool {
	if len(a.Config) == 0 || string(a.Config) == "null" {
		return true
	}
	var cfg automationConfig
	if json.Unmarshal(a.Config, &cfg) != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_config", "配置格式错误")
		return false
	}
	if len(cfg.Actions) == 0 {
		return true
	}
	allFields, err := s.Store.Fields(r.Context(), baseID)
	if err != nil {
		s.fail(w, r, err)
		return false
	}
	tables, err := s.Store.BaseTables(r.Context(), baseID)
	if err != nil {
		s.fail(w, r, err)
		return false
	}
	tableSet := make(map[int64]bool, len(tables))
	for _, tbl := range tables {
		tableSet[tbl.ID] = true
	}
	if err := validateAutomationActionList(cfg.Actions, allFields, tableSet); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_config", err.Error())
		return false
	}
	return true
}

func validateAutomationActionList(actions []automationAction, allFields []store.Field, tableSet map[int64]bool) error {
	total := 0
	resolveFields := func(tableID *int64) ([]store.Field, error) {
		if tableID == nil {
			return allFields, nil
		}
		if *tableID <= 0 || (len(tableSet) > 0 && !tableSet[*tableID]) {
			return nil, fmt.Errorf("目标数据表 %d 不存在", *tableID)
		}
		return filterFieldsByTable(allFields, *tableID), nil
	}
	validateCells := func(targetFields []store.Field, cells map[string]any) error {
		byID := make(map[string]store.Field, len(targetFields))
		for _, f := range targetFields {
			byID[strconv.FormatInt(f.ID, 10)] = f
		}
		for fidStr, rawVal := range cells {
			f, ok := byID[fidStr]
			if !ok {
				return fmt.Errorf("未知字段 %s", fidStr)
			}
			if !store.FieldStored(f.Type) || f.Type == "formula" {
				return fmt.Errorf("字段「%s」不支持自动化写入", f.Name)
			}
			if s, ok := rawVal.(string); ok && utf8.RuneCountInString(s) > 10000 {
				return fmt.Errorf("字段「%s」写入值过长", f.Name)
			}
		}
		return nil
	}
	validateRules := func(targetFields []store.Field, conj string, rules []btquery.Rule) error {
		if conj != "" && conj != "and" && conj != "or" {
			return fmt.Errorf("conj 必须是 and/or")
		}
		byID := make(map[int64]store.Field, len(targetFields))
		for _, f := range targetFields {
			byID[f.ID] = f
		}
		for _, rule := range rules {
			if !btquery.OpsValid(rule.Op) {
				return fmt.Errorf("未知操作 %s", rule.Op)
			}
			if _, ok := byID[rule.F]; !ok {
				return fmt.Errorf("未知字段 %d", rule.F)
			}
		}
		return nil
	}

	var walk func(list []automationAction, ifDepth int) error
	walk = func(list []automationAction, ifDepth int) error {
		for _, act := range list {
			total++
			if total > maxAutomationActions {
				return fmt.Errorf("自动化最多配置 %d 个执行动作", maxAutomationActions)
			}
			if act.ID != "" && (len(act.ID) > 64 || !utf8.ValidString(act.ID) || strings.ContainsRune(act.ID, 0)) {
				return fmt.Errorf("动作 ID 无效")
			}
			switch act.Type {
			case "create_record":
				targetFields, err := resolveFields(act.TableID)
				if err != nil {
					return err
				}
				if err := validateCells(targetFields, act.Cells); err != nil {
					return err
				}
			case "update_record":
				if act.TargetScope != "" && act.TargetScope != "trigger" && act.TargetScope != "found" {
					return fmt.Errorf("targetScope 必须是 trigger 或 found")
				}
				targetFields, err := resolveFields(act.TableID)
				if err != nil {
					return err
				}
				if err := validateCells(targetFields, act.Cells); err != nil {
					return err
				}
			case "find_records":
				targetFields, err := resolveFields(act.TableID)
				if err != nil {
					return err
				}
				if act.Limit < 0 || act.Limit > maxAutomationFindLimit {
					return fmt.Errorf("查找记录 limit 必须在 1-%d 之间", maxAutomationFindLimit)
				}
				if err := validateRules(targetFields, act.Conj, act.Rules); err != nil {
					return err
				}
			case "if_condition":
				if ifDepth >= maxAutomationIfDepth {
					return fmt.Errorf("条件分支最多嵌套 %d 层", maxAutomationIfDepth)
				}
				targetFields, err := resolveFields(act.TableID)
				if err != nil {
					return err
				}
				if err := validateRules(targetFields, act.Conj, act.Rules); err != nil {
					return err
				}
				if err := walk(act.ThenActions, ifDepth+1); err != nil {
					return err
				}
				if err := walk(act.ElseActions, ifDepth+1); err != nil {
					return err
				}
			case "notify":
				if len(act.NotifyUsers) > 20 {
					return fmt.Errorf("最多通知 20 人")
				}
				if utf8.RuneCountInString(act.Message) > 500 {
					return fmt.Errorf("消息最长 500 字")
				}
			case "webhook":
				if act.Webhook == nil || act.Webhook.URL == "" {
					return fmt.Errorf("webhook 动作需要配置 URL")
				}
				if msg := validateWebhookConfig(*act.Webhook, act.Message); msg != "" {
					return fmt.Errorf("%s", msg)
				}
			default:
				return fmt.Errorf("未知动作类型 %q", act.Type)
			}
		}
		return nil
	}
	return walk(actions, 0)
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
	if !validSchedule(w, a) {
		return
	}
	if !s.validateAutomationActions(w, r, b.ID, a) {
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	a, err := s.Store.MutateAutomationGuarded(r.Context(), guard, b.ID, nil, &a)
	if err != nil {
		s.automationMutationError(w, r, err)
		return
	}
	if s.BtHub != nil {
		s.BtHub.Notify(b.ID)
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
	if !validSchedule(w, a) {
		return
	}
	if !s.validateAutomationActions(w, r, b.ID, a) {
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	if a, err = s.Store.MutateAutomationGuarded(r.Context(), guard, b.ID, cur, &a); err != nil {
		s.automationMutationError(w, r, err)
		return
	}
	if s.BtHub != nil {
		s.BtHub.Notify(b.ID)
	}
	httpx.JSON(w, http.StatusOK, a)
}

func (s *Server) deleteAutomation(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
		return
	}
	as, err := s.Store.Automations(r.Context(), b.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	var current *store.Automation
	for i := range as {
		if as[i].ID == pathID(r, "aid") {
			current = &as[i]
			break
		}
	}
	if current == nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "自动化不存在")
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	if _, err := s.Store.MutateAutomationGuarded(r.Context(), guard, b.ID, current, nil); err != nil {
		s.automationMutationError(w, r, err)
		return
	}
	if s.BtHub != nil {
		s.BtHub.Notify(b.ID)
	}
	w.WriteHeader(http.StatusNoContent)
}

func validSchedule(w http.ResponseWriter, a store.Automation) bool {
	if a.TriggerKind != "schedule" {
		return true
	}
	var cfg automationConfig
	if json.Unmarshal(a.Config, &cfg) != nil || cfg.Schedule == nil || !scheduleEvery[cfg.Schedule.Every] {
		httpx.Error(w, http.StatusBadRequest, "invalid_config", "定时触发需要 schedule.every = 1h/1d/1w")
		return false
	}
	return true
}

func (s *Server) automationMutationError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, store.ErrUnauthenticated):
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
	case errors.Is(err, store.ErrForbidden):
		httpx.Error(w, http.StatusForbidden, "forbidden", "当前权限无法修改自动化")
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "自动化不存在")
	case errors.Is(err, store.ErrConflict):
		httpx.Error(w, http.StatusConflict, "automation_conflict", "自动化已变化，请刷新后重试")
	default:
		s.fail(w, r, err)
	}
}

// ---- execution ----

var tmplVar = regexp.MustCompile(`\{\{([^}]+)\}\}`)

type automationExecEnv struct {
	baseID     int64
	baseTitle  string
	allFields  []store.Field
	triggerRec store.Record
	found      []store.Record
	skipActor  int64
}

// SweepSchedules fires every due schedule automation across all bases. The
// sweeper goroutine calls it once per minute; a firing is "due" when
// last_fired_at is older than the configured interval. Rules (when present)
// gate on at least one matching record, with the message interpolated from
// the first match.
func (s *Server) SweepSchedules(ctx context.Context) {
	asis, err := s.Store.AllAutomations(ctx)
	if err != nil {
		s.Log.Error("sweep automations", "err", err)
		return
	}
	now := time.Now()
	for _, a := range asis {
		if !a.Enabled || a.TriggerKind != "schedule" {
			continue
		}
		var cfg automationConfig
		if json.Unmarshal(a.Config, &cfg) != nil || cfg.Schedule == nil {
			continue
		}
		gap := scheduleGap(cfg.Schedule.Every)
		if !a.LastFiredAt.IsZero() && now.Sub(a.LastFiredAt) < gap {
			continue
		}
		fields, err := s.Store.Fields(ctx, a.BaseID)
		if err != nil {
			continue
		}
		recs, err := s.Store.Records(ctx, a.BaseID)
		if err != nil {
			continue
		}
		var hit *store.Record
		if len(cfg.Rules) > 0 {
			conj := cfg.Conj
			if conj == "" {
				conj = "and"
			}
			for i := range recs {
				if matchRecordTriggerRules(fields, recs[i], cfg.Rules, conj) {
					hit = &recs[i]
					break
				}
			}
			if hit == nil {
				// 不满足条件也算触发周期（避免每分钟重扫），但不发通知
				_ = s.Store.MarkFired(ctx, a.ID, now)
				continue
			}
		} else {
			if len(recs) == 0 {
				if len(cfg.Actions) == 0 {
					_ = s.Store.MarkFired(ctx, a.ID, now)
					continue
				}
				empty := store.Record{BaseID: a.BaseID, Cells: map[string]json.RawMessage{}}
				hit = &empty
			} else {
				hit = &recs[0]
			}
		}
		s.fireAutomation(ctx, a.BaseID, a.Name, cfg, fields, *hit, 0)
		_ = s.Store.MarkFired(ctx, a.ID, now)
	}
}

// matchRecordTriggerRules evaluates trigger rules against a record while
// ensuring rules targeting fields on a different table do not falsely match
// (for example via an "empty" operator).
func matchRecordTriggerRules(allFields []store.Field, rec store.Record, rules []btquery.Rule, conj string) bool {
	if len(rules) == 0 {
		return true
	}
	tableFields := filterFieldsByTable(allFields, rec.TableID)
	inTable := make(map[int64]bool, len(tableFields))
	for _, f := range tableFields {
		inTable[f.ID] = true
	}
	for _, r := range rules {
		if rec.TableID > 0 && !inTable[r.F] {
			return false
		}
	}
	return btquery.MatchRules(store.Specs(tableFields), rules, conj, rec.Cells)
}

// runAutomations evaluates enabled automations of the given trigger for one
// record: in-app notifications, webhook pushes, and read/write/branch actions.
// Called synchronously after the write; recursion depth is bounded to prevent
// infinite automation loops.
func (s *Server) runAutomations(ctx context.Context, baseID int64, trigger string, rec store.Record) {
	if automationDepth(ctx) >= maxAutomationDepth {
		if s.Log != nil {
			s.Log.Warn("automation max recursion depth reached", "base", baseID, "trigger", trigger, "record", rec.ID)
		}
		return
	}
	asis, err := s.Store.Automations(ctx, baseID)
	if err != nil {
		if s.Log != nil {
			s.Log.Error("automations load", "err", err)
		}
		return
	}
	if len(asis) == 0 {
		return
	}
	fields, err := s.Store.Fields(ctx, baseID)
	if err != nil {
		if s.Log != nil {
			s.Log.Error("automations fields", "err", err)
		}
		return
	}
	var actor store.User // 匿名表单提交时无用户
	if u, ok := UserFrom(ctx); ok {
		actor = u
	}
	skipActor := actorIDOrZero(actor)
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
			if !matchRecordTriggerRules(fields, rec, cfg.Rules, conj) {
				continue
			}
		}
		s.fireAutomation(ctx, baseID, a.Name, cfg, fields, rec, skipActor)
	}
}

// fireAutomation runs one automation's legacy notify/webhook fields plus any
// structured Actions for one record; skipActor hides the triggering user from
// recipients when non-zero.
func (s *Server) fireAutomation(ctx context.Context, baseID int64, automationName string, cfg automationConfig, fields []store.Field, rec store.Record, skipActor int64) {
	if automationDepth(ctx) >= maxAutomationDepth {
		return
	}
	var wsID int64
	baseTitle := ""
	if doc, err := s.Store.GetDocSystem(ctx, baseID); err == nil {
		baseTitle = doc.Title
		wsID = doc.WorkspaceID
	}
	env := &automationExecEnv{
		baseID:     baseID,
		baseTitle:  baseTitle,
		allFields:  fields,
		triggerRec: rec,
		skipActor:  skipActor,
	}

	// Legacy top-level notification & webhook (100% backward compatible).
	if len(cfg.NotifyUsers) > 0 {
		s.sendAutomationNotifications(ctx, env, cfg.NotifyUsers, cfg.Message)
	}
	if cfg.Webhook.URL != "" {
		s.pushWebhook(ctx, cfg.Webhook, interpolateTemplate(cfg.Webhook.Message, env))
	}

	// Structured multi-step actions.
	if len(cfg.Actions) > 0 {
		s.executeAutomationActions(ctx, env, cfg.Actions, 0)
	}

	// External notification channels subscribed to "automation" events.
	if wsID > 0 {
		titleBase := strings.TrimSpace(baseTitle)
		if titleBase == "" {
			titleBase = "多维表"
		}
		ruleName := strings.TrimSpace(automationName)
		title := fmt.Sprintf("【自动化触发】%s", titleBase)
		if ruleName != "" {
			title = fmt.Sprintf("【自动化触发】%s - %s", titleBase, ruleName)
		}
		body := strings.TrimSpace(interpolateTemplate(cfg.Message, env))
		if body == "" {
			body = fmt.Sprintf("多维表「%s」中的自动化流程已执行完成。", titleBase)
		}
		s.dispatchWorkspaceNotification(wsID, store.NotificationEventAutomation, title, body, fmt.Sprintf("/bases/%d", baseID))
	}
}

func (s *Server) sendAutomationNotifications(ctx context.Context, env *automationExecEnv, users []int64, message string) {
	items := make([]store.Notification, 0, len(users))
	var commentID *int64
	if env.triggerRec.ID > 0 {
		id := env.triggerRec.ID
		commentID = &id
	}
	preview := snippet(interpolateTemplate(message, env))
	for _, uid := range users {
		if env.skipActor != 0 && uid == env.skipActor {
			continue
		}
		items = append(items, store.Notification{
			UserID: uid, DocID: env.baseID, ActorID: env.skipActor,
			CommentID: commentID, Kind: "mention",
			Preview: preview,
		})
	}
	if len(items) > 0 {
		if err := s.Store.AddNotifications(ctx, items); err != nil && s.Log != nil {
			s.Log.Error("automations notify", "err", err)
		}
	}
}

func (s *Server) executeAutomationActions(ctx context.Context, env *automationExecEnv, actions []automationAction, ifDepth int) {
	if ifDepth > maxAutomationIfDepth {
		return
	}
	for _, act := range actions {
		switch act.Type {
		case "create_record":
			targetTableID := env.triggerRec.TableID
			if act.TableID != nil && *act.TableID > 0 {
				targetTableID = *act.TableID
			}
			targetFields := filterFieldsByTable(env.allFields, targetTableID)
			cells := coerceAutomationCells(targetFields, act.Cells, env, true)
			var creator *int64
			if env.skipActor > 0 {
				id := env.skipActor
				creator = &id
			}
			created, err := s.Store.AddRecord(ctx, store.Record{
				BaseID:    env.baseID,
				TableID:   targetTableID,
				Cells:     cells,
				CreatorID: creator,
			})
			if err != nil {
				if s.Log != nil {
					s.Log.Error("automation create_record", "base", env.baseID, "err", err)
				}
				continue
			}
			s.btEvent(ctx, env.baseID, map[string]any{"kind": "reload"})
			s.runAutomations(withNextAutomationDepth(ctx), env.baseID, "record_matches", created)

		case "update_record":
			if act.TargetScope == "found" {
				targets := env.found
				if len(targets) > maxAutomationFindLimit {
					targets = targets[:maxAutomationFindLimit]
				}
				updatedList := make([]store.Record, 0, len(targets))
				for _, target := range targets {
					if target.ID <= 0 {
						continue
					}
					targetFields := filterFieldsByTable(env.allFields, target.TableID)
					cells := coerceAutomationCells(targetFields, act.Cells, env, false)
					if len(cells) == 0 {
						continue
					}
					updated, err := s.Store.SetCells(ctx, env.baseID, target.ID, cells)
					if err != nil {
						if s.Log != nil {
							s.Log.Error("automation update_record(found)", "base", env.baseID, "record", target.ID, "err", err)
						}
						continue
					}
					updatedList = append(updatedList, updated)
				}
				if len(updatedList) > 0 {
					s.btEvent(ctx, env.baseID, map[string]any{"kind": "reload"})
					nextCtx := withNextAutomationDepth(ctx)
					for _, uRec := range updatedList {
						s.runAutomations(nextCtx, env.baseID, "record_matches", uRec)
					}
				}
			} else {
				if env.triggerRec.ID <= 0 {
					continue
				}
				targetFields := filterFieldsByTable(env.allFields, env.triggerRec.TableID)
				cells := coerceAutomationCells(targetFields, act.Cells, env, false)
				if len(cells) == 0 {
					continue
				}
				updated, err := s.Store.SetCells(ctx, env.baseID, env.triggerRec.ID, cells)
				if err != nil {
					if s.Log != nil {
						s.Log.Error("automation update_record(trigger)", "base", env.baseID, "record", env.triggerRec.ID, "err", err)
					}
					continue
				}
				env.triggerRec = updated
				s.btEvent(ctx, env.baseID, map[string]any{"kind": "reload"})
				s.runAutomations(withNextAutomationDepth(ctx), env.baseID, "record_matches", updated)
			}

		case "find_records":
			targetTableID := env.triggerRec.TableID
			if act.TableID != nil && *act.TableID > 0 {
				targetTableID = *act.TableID
			}
			targetFields := filterFieldsByTable(env.allFields, targetTableID)
			specs := store.Specs(targetFields)
			limit := act.Limit
			if limit <= 0 {
				limit = defaultAutomationFindRows
			}
			if limit > maxAutomationFindLimit {
				limit = maxAutomationFindLimit
			}
			conj := act.Conj
			if conj == "" {
				conj = "and"
			}
			resolvedRules := resolveAutomationRules(act.Rules, env)
			allRecs, err := s.Store.Records(ctx, env.baseID)
			if err != nil {
				if s.Log != nil {
					s.Log.Error("automation find_records", "base", env.baseID, "err", err)
				}
				env.found = nil
				continue
			}
			matched := make([]store.Record, 0, limit)
			for _, rec := range allRecs {
				if targetTableID > 0 && rec.TableID > 0 && rec.TableID != targetTableID {
					continue
				}
				if len(resolvedRules) == 0 || btquery.MatchRules(specs, resolvedRules, conj, rec.Cells) {
					matched = append(matched, rec)
					if len(matched) >= limit {
						break
					}
				}
			}
			env.found = matched

		case "if_condition":
			targetTableID := env.triggerRec.TableID
			if act.TableID != nil && *act.TableID > 0 {
				targetTableID = *act.TableID
			}
			targetFields := filterFieldsByTable(env.allFields, targetTableID)
			conj := act.Conj
			if conj == "" {
				conj = "and"
			}
			resolvedRules := resolveAutomationRules(act.Rules, env)
			if btquery.MatchRules(store.Specs(targetFields), resolvedRules, conj, env.triggerRec.Cells) {
				s.executeAutomationActions(ctx, env, act.ThenActions, ifDepth+1)
			} else {
				s.executeAutomationActions(ctx, env, act.ElseActions, ifDepth+1)
			}

		case "notify":
			if len(act.NotifyUsers) > 0 {
				s.sendAutomationNotifications(ctx, env, act.NotifyUsers, act.Message)
			}

		case "webhook":
			if act.Webhook != nil && act.Webhook.URL != "" {
				msg := act.Webhook.Message
				if msg == "" {
					msg = act.Message
				}
				s.pushWebhook(ctx, *act.Webhook, interpolateTemplate(msg, env))
			}
		}
	}
}

func resolveAutomationRules(rules []btquery.Rule, env *automationExecEnv) []btquery.Rule {
	if len(rules) == 0 {
		return nil
	}
	out := make([]btquery.Rule, len(rules))
	for i, r := range rules {
		if s, ok := r.V.(string); ok && strings.Contains(s, "{{") {
			r.V = interpolateTemplate(s, env)
		}
		out[i] = r
	}
	return out
}

func coerceAutomationCells(targetFields []store.Field, rawCells map[string]any, env *automationExecEnv, isCreate bool) map[string]json.RawMessage {
	byID := make(map[string]store.Field, len(targetFields))
	for _, f := range targetFields {
		byID[strconv.FormatInt(f.ID, 10)] = f
	}
	out := make(map[string]json.RawMessage, len(rawCells))
	for fidStr, val := range rawCells {
		f, ok := byID[fidStr]
		if !ok || !store.FieldStored(f.Type) || f.Type == "formula" {
			continue
		}
		if val == nil {
			if !isCreate {
				out[fidStr] = json.RawMessage("null")
			}
			continue
		}
		if raw := coerceAutomationCellValue(f, val, env); raw != nil {
			out[fidStr] = raw
		}
	}
	if isCreate {
		for _, f := range targetFields {
			k := strconv.FormatInt(f.ID, 10)
			if _, given := out[k]; !given && len(f.DefaultValue) > 0 && defaultableTypes[f.Type] && validCell(f, f.DefaultValue) {
				out[k] = f.DefaultValue
			}
		}
	}
	return out
}

func coerceAutomationCellValue(f store.Field, val any, env *automationExecEnv) json.RawMessage {
	marshalValid := func(v any) json.RawMessage {
		b, err := json.Marshal(v)
		if err != nil || !validCell(f, b) {
			return nil
		}
		return b
	}
	if str, ok := val.(string); ok {
		rendered := interpolateTemplate(str, env)
		switch f.Type {
		case "text", "url", "phone", "email", "date", "select", "location":
			return marshalValid(rendered)
		case "number", "currency":
			n, err := strconv.ParseFloat(strings.TrimSpace(rendered), 64)
			if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
				return nil
			}
			return marshalValid(n)
		case "progress":
			cleaned := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(rendered), "%"))
			n, err := strconv.ParseFloat(cleaned, 64)
			if err != nil || math.IsNaN(n) || math.IsInf(n, 0) || n < 0 || n > 100 {
				return nil
			}
			return marshalValid(n)
		case "rating":
			n, err := strconv.Atoi(strings.TrimSpace(rendered))
			if err != nil {
				return nil
			}
			return marshalValid(n)
		case "checkbox":
			switch strings.ToLower(strings.TrimSpace(rendered)) {
			case "true", "1", "yes", "是", "✓", "x":
				return marshalValid(true)
			case "false", "0", "no", "否":
				return marshalValid(false)
			}
			return nil
		case "multi_select":
			parts := strings.FieldsFunc(rendered, func(r rune) bool {
				return r == ',' || r == '，' || r == ';' || r == '；'
			})
			cleaned := make([]string, 0, len(parts))
			for _, p := range parts {
				p = strings.TrimSpace(p)
				if p != "" {
					cleaned = append(cleaned, p)
				}
			}
			return marshalValid(cleaned)
		case "person":
			parts := strings.FieldsFunc(rendered, func(r rune) bool {
				return r == ',' || r == '，' || r == ';' || r == '；' || r == '、'
			})
			ids := make([]int64, 0, len(parts))
			for _, p := range parts {
				id, err := strconv.ParseInt(strings.TrimSpace(p), 10, 64)
				if err == nil && id > 0 {
					ids = append(ids, id)
				}
			}
			if len(ids) == 0 {
				return nil
			}
			if f.Multiple {
				return marshalValid(ids)
			}
			return marshalValid(ids[0])
		default:
			return marshalValid(rendered)
		}
	}
	return marshalValid(val)
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
		if s.Log != nil {
			s.Log.Error("automation webhook", "url", wh.URL, "err", err)
		}
		return
	}
	res.Body.Close()
	if res.StatusCode >= 300 && s.Log != nil {
		s.Log.Error("automation webhook", "url", wh.URL, "status", res.StatusCode)
	}
}

func actorIDOrZero(u store.User) int64 {
	if u.ID == 0 {
		return 0
	}
	return u.ID
}

func formatRecordCellForTemplate(f store.Field, rec store.Record) string {
	switch f.Type {
	case "created_by":
		if rec.CreatorID != nil {
			return strconv.FormatInt(*rec.CreatorID, 10)
		}
		return ""
	case "created_at":
		if rec.CreatedAt != nil {
			return rec.CreatedAt.Format(time.RFC3339)
		}
		return ""
	case "modified_at":
		if rec.UpdatedAt != nil {
			return rec.UpdatedAt.Format(time.RFC3339)
		}
		return ""
	}
	raw, ok := rec.Cells[strconv.FormatInt(f.ID, 10)]
	if !ok {
		return ""
	}
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return ""
	}
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(x)
	case []any:
		// Person/link/multi_select arrays render as a comma-joined list.
		parts := make([]string, 0, len(x))
		for _, item := range x {
			switch n := item.(type) {
			case float64:
				parts = append(parts, strconv.FormatFloat(n, 'f', -1, 64))
			case string:
				parts = append(parts, n)
			}
		}
		if len(parts) > 0 {
			return strings.Join(parts, ",")
		}
	}
	return ""
}

// interpolateTemplate expands {{field:<id>}}, {{record.id}}, {{base.title}},
// {{found.count}}, and legacy {{字段名}} without truncating the output.
func interpolateTemplate(tmpl string, env *automationExecEnv) string {
	if tmpl == "" || !strings.Contains(tmpl, "{{") {
		return tmpl
	}
	return tmplVar.ReplaceAllStringFunc(tmpl, func(m string) string {
		token := strings.TrimSpace(tmplVar.FindStringSubmatch(m)[1])
		switch token {
		case "record.id":
			return strconv.FormatInt(env.triggerRec.ID, 10)
		case "base.title":
			return env.baseTitle
		case "found.count":
			return strconv.Itoa(len(env.found))
		}
		if strings.HasPrefix(token, "field:") {
			idStr := strings.TrimSpace(strings.TrimPrefix(token, "field:"))
			fid, err := strconv.ParseInt(idStr, 10, 64)
			if err == nil && fid > 0 {
				for _, f := range env.allFields {
					if f.ID == fid {
						return formatRecordCellForTemplate(f, env.triggerRec)
					}
				}
			}
			return m
		}
		// Prefer fields from the triggering record's table, then fall back to all base fields.
		for _, f := range filterFieldsByTable(env.allFields, env.triggerRec.TableID) {
			if f.Name == token {
				return formatRecordCellForTemplate(f, env.triggerRec)
			}
		}
		for _, f := range env.allFields {
			if f.Name == token {
				return formatRecordCellForTemplate(f, env.triggerRec)
			}
		}
		return m
	})
}

// renderTemplate interpolates {{字段名}} and structured tokens from the record's cells
// and truncates to a notification preview snippet.
func renderTemplate(tmpl string, fields []store.Field, rec store.Record) string {
	return snippet(interpolateTemplate(tmpl, &automationExecEnv{
		allFields:  fields,
		triggerRec: rec,
	}))
}
