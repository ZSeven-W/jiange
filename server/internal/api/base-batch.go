package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func (s *Server) writeBaseBatchErr(w http.ResponseWriter, r *http.Request, err error) bool {
	if err == nil {
		return false
	}
	var invalid invalidRecordCells
	switch {
	case errors.Is(err, store.ErrUnauthenticated):
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效，批量操作未执行")
	case errors.Is(err, store.ErrForbidden):
		httpx.Error(w, http.StatusForbidden, "forbidden", "当前权限不允许执行批量记录操作")
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "部分记录或数据表不存在，批量操作已整体回滚")
	case errors.Is(err, store.ErrExpectedCells):
		httpx.Error(w, http.StatusConflict, "cells_changed", "部分单元格已被他人修改，批量撤销未执行")
	case errors.Is(err, store.ErrConflict):
		httpx.Error(w, http.StatusConflict, "conflict", "记录或表结构已变化，请刷新后重试")
	case errors.As(err, &invalid):
		httpx.Error(w, http.StatusBadRequest, "invalid_cell", invalid.message)
	case errors.Is(err, store.ErrPrimaryField):
		httpx.Error(w, http.StatusConflict, "primary_field", "不能修改主字段位置或以主字段身份恢复")
	case errors.Is(err, store.ErrInvalidBaseRecord):
		httpx.Error(w, http.StatusBadRequest, "invalid_cell", "批量操作参数无效")
	default:
		s.fail(w, r, err)
	}
	return true
}

func (s *Server) batchDeleteBaseRecords(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
		return
	}
	guard, ok := s.baseGuardFromCookie(w, r)
	if !ok {
		return
	}
	var in struct {
		IDs []int64 `json:"ids"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	u, _ := UserFrom(r.Context())
	if !s.checkBaseRecordOpPolicy(w, r, b, u.ID, "delete", 0, in.IDs, nil, nil) {
		return
	}
	deleted, affected, err := s.Store.BatchDeleteRecordsGuarded(r.Context(), guard, b.ID, in.IDs)
	if s.writeBaseBatchErr(w, r, err) {
		return
	}
	if s.BtHub != nil {
		for _, bid := range affected {
			s.BtHub.Notify(bid)
		}
	}
	if len(deleted) > 0 {
		s.dispatchWorkspaceEvent(b.WorkspaceID, store.WebhookEventBaseRecordMutated, map[string]any{
			"baseId":  b.ID,
			"tableId": deleted[0].TableID,
			"action":  "batch_delete",
			"count":   len(deleted),
			"actorId": u.ID,
		})
	}
	w.Header().Set("Cache-Control", "private, no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": deleted})
}

func (s *Server) batchRestoreBaseRecords(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
		return
	}
	guard, ok := s.baseGuardFromCookie(w, r)
	if !ok {
		return
	}
	var in struct {
		Records []store.BatchRestoreRecordInput `json:"records"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	u, _ := UserFrom(r.Context())
	for _, rec := range in.Records {
		if !s.checkBaseRecordOpPolicy(w, r, b, u.ID, "add", rec.TableID, nil, []map[string]json.RawMessage{rec.Cells}, nil) {
			return
		}
	}
	restored, affected, err := s.Store.BatchRestoreRecordsGuarded(r.Context(), guard, b.ID, in.Records, func(fields []store.Field, cells map[string]json.RawMessage) error {
		if msg := checkCells(fields, cells); msg != "" {
			return invalidRecordCells{msg}
		}
		return nil
	})
	if s.writeBaseBatchErr(w, r, err) {
		return
	}
	if s.BtHub != nil {
		for _, bid := range affected {
			s.BtHub.Notify(bid)
		}
	}
	if len(restored) > 0 {
		s.dispatchWorkspaceEvent(b.WorkspaceID, store.WebhookEventBaseRecordMutated, map[string]any{
			"baseId":  b.ID,
			"tableId": restored[0].TableID,
			"action":  "batch_restore",
			"count":   len(restored),
			"actorId": u.ID,
		})
	}
	w.Header().Set("Cache-Control", "private, no-store")
	httpx.JSON(w, http.StatusCreated, map[string]any{"records": restored})
}

func (s *Server) batchUpdateBaseRecords(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
		return
	}
	guard, ok := s.baseGuardFromCookie(w, r)
	if !ok {
		return
	}
	var in struct {
		Updates []store.BatchCellUpdateInput `json:"updates"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	u, _ := UserFrom(r.Context())
	ids := make([]int64, len(in.Updates))
	cellMaps := make([]map[string]json.RawMessage, len(in.Updates))
	expectedMaps := make([]map[string]json.RawMessage, len(in.Updates))
	for i, upd := range in.Updates {
		ids[i] = upd.RecordID
		cellMaps[i] = upd.Cells
		expectedMaps[i] = upd.Expected
	}
	if !s.checkBaseRecordOpPolicy(w, r, b, u.ID, "update", 0, ids, cellMaps, expectedMaps) {
		return
	}
	updated, affected, err := s.Store.BatchUpdateCellsGuarded(r.Context(), guard, b.ID, in.Updates, func(fields []store.Field, cells map[string]json.RawMessage) error {
		if msg := checkCells(fields, cells); msg != "" {
			return invalidRecordCells{msg}
		}
		return nil
	})
	if s.writeBaseBatchErr(w, r, err) {
		return
	}
	if s.BtHub != nil {
		for _, bid := range affected {
			s.BtHub.Notify(bid)
		}
	}
	if len(updated) > 0 {
		s.dispatchWorkspaceEvent(b.WorkspaceID, store.WebhookEventBaseRecordMutated, map[string]any{
			"baseId":  b.ID,
			"tableId": updated[0].TableID,
			"action":  "batch_update",
			"count":   len(updated),
			"actorId": u.ID,
		})
	}
	w.Header().Set("Cache-Control", "private, no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{"records": updated})
}

func (s *Server) restoreBaseField(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
		return
	}
	guard, ok := s.baseGuardFromCookie(w, r)
	if !ok {
		return
	}
	var in store.RestoreFieldInput
	if !httpx.Decode(w, r, &in) {
		return
	}
	field, restored, err := s.Store.RestoreFieldGuarded(r.Context(), guard, b.ID, in, func(f store.Field, val json.RawMessage) error {
		if !validCell(f, val) {
			return invalidRecordCells{message: "恢复的单元格值与字段类型不匹配"}
		}
		return nil
	})
	if s.writeBaseBatchErr(w, r, err) {
		return
	}
	if s.BtHub != nil {
		s.BtHub.Notify(b.ID)
	}
	w.Header().Set("Cache-Control", "private, no-store")
	httpx.JSON(w, http.StatusCreated, map[string]any{"field": field, "restoredCells": restored})
}
