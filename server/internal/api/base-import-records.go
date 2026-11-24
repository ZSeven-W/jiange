package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strconv"

	"github.com/ZSeven-W/jiange/server/internal/auth"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type importRecordField struct {
	ID      int64    `json:"id"`
	Name    string   `json:"name"`
	Type    string   `json:"type"`
	Options []string `json:"options"`
}

func expectedImportAccount(w http.ResponseWriter, r *http.Request, userID int64, required bool) bool {
	raw := r.Header.Get("X-Jiange-User-Id")
	if raw == "" && !required {
		return true
	}
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 || id != userID {
		httpx.Error(w, http.StatusUnauthorized, "session_changed", "登录账号已变化，请重新开始操作")
		return false
	}
	return true
}

func (s *Server) baseAIImportPreview(w http.ResponseWriter, r *http.Request) {
	u, ok := UserFrom(r.Context())
	if !ok || !expectedImportAccount(w, r, u.ID, true) {
		return
	}
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok || !s.allowBaseWrite(w, r, b) {
		return
	}
	s.docAI(w, r)
}

// Import only into the schema the user previewed. The existing import store
// commits all records and the reload event under its authorization/schema lock.
func (s *Server) importBaseRecords(w http.ResponseWriter, r *http.Request) {
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "请重新登录")
		return
	}
	if !expectedImportAccount(w, r, u.ID, true) {
		return
	}
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
		return
	}
	var in struct {
		Fields []importRecordField          `json:"fields"`
		Rows   []map[string]json.RawMessage `json:"rows"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if len(in.Fields) == 0 || len(in.Fields) > 50 || len(in.Rows) == 0 || len(in.Rows) > 50 {
		httpx.Error(w, http.StatusBadRequest, "invalid_import", "最多导入 50 条记录和 50 个字段")
		return
	}
	if b.Role != store.RoleManage {
		p, _, policyErr := s.basePolicyForRequest(r.Context(), r, b, u.ID, 0)
		if policyErr != nil {
			s.fail(w, r, policyErr)
			return
		}
		if !p.canAddRecord {
			httpx.Error(w, http.StatusForbidden, "forbidden", "当前权限不允许新增或导入记录")
			return
		}
		for _, expected := range in.Fields {
			if p.hidden[expected.ID] || p.readonly[expected.ID] {
				httpx.Error(w, http.StatusForbidden, "forbidden", "该字段为只读或隐藏状态，无法导入")
				return
			}
		}
	}
	cookie, err := r.Cookie(CookieName)
	if err != nil || cookie.Value == "" {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
		return
	}
	guard := store.BaseWriteGuard{UserID: u.ID, SessionHash: auth.HashToken(cookie.Value), Now: s.now}
	count, err := s.Store.ImportBaseCSV(r.Context(), guard, b.ID, func(fields []store.Field) (store.BaseImportPlan, error) {
		byID := make(map[int64]store.Field, len(fields))
		for _, f := range fields {
			byID[f.ID] = f
		}
		indexes := make(map[string]int, len(in.Fields))
		plan := store.BaseImportPlan{}
		for i, expected := range in.Fields {
			f, exists := byID[expected.ID]
			key := strconv.FormatInt(expected.ID, 10)
			if _, duplicate := indexes[key]; duplicate || !exists || f.Name != expected.Name || f.Type != expected.Type || !slices.Equal(f.Options, expected.Options) {
				return store.BaseImportPlan{}, store.ErrConflict
			}
			switch f.Type {
			case "text", "number", "checkbox", "date", "select", "multi_select", "url", "phone", "email", "rating", "currency", "progress", "location":
			default:
				return store.BaseImportPlan{}, store.ErrConflict
			}
			indexes[key] = i
			plan.Columns = append(plan.Columns, store.ImportColumn{ExistingID: f.ID})
		}
		// Apply current field defaults just as an ordinary new record does,
		// including defaults on fields that were not sent to the model.
		defaults := make(map[int]json.RawMessage)
		for _, f := range fields {
			if len(f.DefaultValue) == 0 || !defaultableTypes[f.Type] || !validCell(f, f.DefaultValue) {
				continue
			}
			key := strconv.FormatInt(f.ID, 10)
			i, exists := indexes[key]
			if !exists {
				i = len(plan.Columns)
				plan.Columns = append(plan.Columns, store.ImportColumn{ExistingID: f.ID})
			}
			defaults[i] = f.DefaultValue
		}
		for _, row := range in.Rows {
			if len(row) == 0 || len(row) > len(indexes) {
				return store.BaseImportPlan{}, store.ErrConflict
			}
			cells := make(map[int]json.RawMessage, len(row)+len(defaults))
			for i, value := range defaults {
				cells[i] = value
			}
			for key, value := range row {
				i, found := indexes[key]
				if !found || bytes.Equal(bytes.TrimSpace(value), []byte("null")) || !validCell(byID[in.Fields[i].ID], value) {
					return store.BaseImportPlan{}, store.ErrConflict
				}
				cells[i] = value
			}
			plan.Rows = append(plan.Rows, cells)
		}
		return plan, nil
	})
	if errors.Is(err, store.ErrUnauthenticated) {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效，未导入数据")
		return
	}
	if errors.Is(err, store.ErrForbidden) || errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusForbidden, "forbidden", "当前无权导入，未修改数据")
		return
	}
	if errors.Is(err, store.ErrConflict) {
		httpx.Error(w, http.StatusConflict, "import_conflict", "字段或识别内容已变化，未导入数据")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if s.BtHub != nil {
		s.BtHub.Notify(b.ID)
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]int{"imported": count})
}
