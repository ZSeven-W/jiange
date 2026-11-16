package api

import (
	"net/http"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
)

// The current view projection omits experimental table content. Returning it
// as a complete document would silently mislead readers and copy/export paths.
func rejectUnsupportedTableView(w http.ResponseWriter, doc *collab.Doc) bool {
	if doc == nil || !doc.HasTables() {
		return false
	}
	httpx.Error(w, http.StatusConflict, "table_unsupported", "当前版本无法安全显示此文档中的表格内容")
	return true
}
