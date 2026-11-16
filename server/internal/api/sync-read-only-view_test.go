package api

import (
	"testing"

	"github.com/ZSeven-W/jiange/server/collab"
)

func TestSyncReadOnlyViewPreservesPreviewDetails(t *testing.T) {
	source := collab.DocView{Blocks: []collab.BlockView{
		{ID: "1:1", Parent: "0:0", Type: "image", Props: map[string]string{"fileId": "1", "name": "图.png", "mime": "image/png", "old": "secret"}},
		{ID: "1:2", Parent: "0:0", Type: "file", Props: map[string]string{"fileId": "2", "name": "文档.txt", "mime": "text/x-private-extra"}},
		{ID: "1:3", Parent: "0:0", Type: "bookmark", Props: map[string]string{"url": "https://example.test", "title": "标题", "description": "网页说明", "icon": "https://example.test/icon.png", "old": "secret"}},
		{ID: "1:4", Parent: "0:0", Type: "columns", Props: map[string]string{}},
		{ID: "1:5", Parent: "1:4", Type: "bookmark", Props: map[string]string{"description": "secret", "icon": "https://example.test/secret"}},
	}}
	view, err := syncReadOnlyView(source)
	if err != nil {
		t.Fatal(err)
	}
	if view.Blocks[0].Props["mime"] != "image/png" || view.Blocks[0].Props["old"] != "" {
		t.Fatalf("image: %#v", view.Blocks[0].Props)
	}
	if view.Blocks[1].Props["mime"] != "text/plain" {
		t.Fatalf("file: %#v", view.Blocks[1].Props)
	}
	if view.Blocks[2].Props["description"] != "网页说明" || view.Blocks[2].Props["icon"] != "https://example.test/icon.png" || view.Blocks[2].Props["old"] != "" {
		t.Fatalf("bookmark: %#v", view.Blocks[2].Props)
	}
	if view.Blocks[4].Props["description"] != "" || view.Blocks[4].Props["icon"] != "" {
		t.Fatalf("column child: %#v", view.Blocks[4].Props)
	}
}
