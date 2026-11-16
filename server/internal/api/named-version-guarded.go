package api

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type namedVersionStore interface {
	CreateNamedVersion(context.Context, store.RestoreGuard, int64, int64, int64, []byte, string) (store.Version, error)
}

func (s *Server) createNamedVersion(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleEdit)
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if r.Header.Get("X-Jiange-User-Id") == "" {
		httpx.Error(w, http.StatusBadRequest, "missing_account", "未确认当前账号")
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	var in struct {
		Label string `json:"label"`
		Epoch int64  `json:"historyEpoch"`
		Head  int64  `json:"expectedSeq"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	in.Label = strings.TrimSpace(in.Label)
	if in.Label == "" || utf8.RuneCountInString(in.Label) > 1000 || in.Epoch <= 0 || in.Head <= 0 || in.Head > 1<<53-1 || in.Epoch > 1<<53-1 {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "版本名称或同步状态无效")
		return
	}
	st, ok := s.Store.(namedVersionStore)
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "unavailable", "安全保存版本服务不可用")
		return
	}
	epoch, head, err := s.Store.HeadVersion(r.Context(), d.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if epoch != in.Epoch || head != in.Head {
		httpx.Error(w, http.StatusConflict, "version_conflict", "文档已变化，请同步完成后重新保存")
		return
	}
	doc, materializedHead, err := StateAtHead(r.Context(), s.Store, d.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if materializedHead != in.Head {
		httpx.Error(w, http.StatusConflict, "version_conflict", "文档已变化，请同步完成后重新保存")
		return
	}
	version, err := st.CreateNamedVersion(r.Context(), guard, d.ID, in.Epoch, in.Head, doc.EncodeState(), in.Label)
	if errors.Is(err, store.ErrConflict) {
		httpx.Error(w, http.StatusConflict, "version_conflict", "文档已变化，或当前内容已有命名版本；请检查历史记录后重试")
		return
	}
	if driveWriteErr(w, err, "create named version") {
		return
	}
	httpx.JSON(w, http.StatusCreated, version)
}
