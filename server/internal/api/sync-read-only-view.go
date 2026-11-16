package api

import (
	"strings"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/syncsrv"
)

// Every document viewer currently uses the same recipient-independent policy.
var documentViewProjector = syncsrv.NewViewProjector(func(doc *collab.Doc) ([]byte, error) {
	original, err := doc.ReadOnlyProjectionView()
	if err != nil {
		return nil, err
	}
	view, err := syncReadOnlyView(original)
	if err != nil {
		return nil, err
	}
	projected, err := doc.ReadOnlyProjection(view)
	if err != nil {
		return nil, err
	}
	return projected.EncodeState(), nil
})

// The live editor displays a few details that the public snapshot renderer
// does not, notably bookmark descriptions/icons and attachment previews.
func syncReadOnlyView(source collab.DocView) (collab.DocView, error) {
	view, err := publicTableView(source)
	if err != nil {
		return collab.DocView{}, err
	}
	types := make(map[string]string, len(source.Blocks))
	for _, block := range source.Blocks {
		types[block.ID] = block.Type
	}
	for i, original := range source.Blocks {
		if types[original.Parent] == "columns" {
			continue
		}
		props := view.Blocks[i].Props
		switch original.Type {
		case "image", "file":
			if mime := syncPreviewMIME(original.Props["mime"]); mime != "" {
				props["mime"] = mime
			}
		case "bookmark":
			if value := original.Props["description"]; value != "" {
				props["description"] = value
			}
			if value := original.Props["icon"]; publicSafeLink(value) && !strings.HasPrefix(value, "#/") {
				props["icon"] = value
			}
		}
	}
	return view, nil
}

func syncPreviewMIME(value string) string {
	switch {
	case value == "image/png" || value == "image/jpeg" || value == "image/gif" || value == "image/webp" || value == "image/avif" || value == "image/bmp" || value == "image/svg+xml":
		return value
	case strings.HasPrefix(value, "image/"):
		return "image/*"
	case strings.HasPrefix(value, "text/"):
		return "text/plain"
	case value == "application/pdf" || value == "application/json" || value == "application/xml" || value == "application/javascript" || value == "application/x-yaml" || value == "application/sql":
		return value
	default:
		return ""
	}
}
