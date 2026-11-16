package api

import (
	"encoding/json"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/ZSeven-W/jiange/server/collab"
)

var publicTextColor = regexp.MustCompile(`^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$`)
var publicCharID = regexp.MustCompile(`^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$`)

// publicCommonBlock projects properties used by public and saved-version
// renderers. Flowchart registers need a separate semantic projection; until
// then they retain their existing behavior and must not be treated as safe.
func publicCommonBlock(block collab.BlockView, children map[string]bool, columnChild bool) collab.BlockView {
	props := block.Props
	clean := map[string]string{}
	if props["align"] == "center" || props["align"] == "right" {
		clean["align"] = props["align"]
	}
	if indent, err := strconv.ParseFloat(strings.TrimSpace(props["indent"]), 64); err == nil && !math.IsNaN(indent) && !math.IsInf(indent, 0) && math.Trunc(indent) == indent && indent >= 0 && indent <= 20 {
		clean["indent"] = strconv.FormatFloat(indent, 'f', -1, 64)
	}
	if columnChild {
		// The columns renderer displays each direct child as text regardless of
		// its block type. Type-specific registers are not displayed there.
		delete(clean, "indent")
		block.Props = clean
		spans := make([]collab.Span, len(block.Spans))
		for i, span := range block.Spans {
			spans[i] = collab.Span{Text: span.Text, Marks: publicTextMarks(span.Marks)}
		}
		block.Spans = spans
		return block
	}
	keep := func(keys ...string) {
		for _, key := range keys {
			if value, ok := props[key]; ok {
				clean[key] = value
			}
		}
	}
	switch block.Type {
	case "todo":
		if props["checked"] == "true" {
			clean["checked"] = "true"
		}
	case "code":
		switch props["lang"] {
		case "plain", "typescript", "javascript", "go", "python", "rust", "java", "sql", "json", "bash", "css", "html":
			clean["lang"] = props["lang"]
		}
		if props["wrap"] == "false" {
			clean["wrap"] = "false"
		}
	case "callout":
		keep("emoji")
		if color, err := strconv.Atoi(props["color"]); err == nil && color >= 0 && color < 7 {
			clean["color"] = strconv.Itoa(color)
		}
	case "columns":
		if widths := publicColumnWidths(props["columnWidths"], children); widths != "" {
			clean["columnWidths"] = widths
		}
	case "image":
		keep("name", "caption")
		if id := publicFileID(props["fileId"]); id != "" {
			clean["fileId"] = id
		}
		if width, err := strconv.ParseFloat(props["imageWidth"], 64); err == nil && !math.IsNaN(width) && !math.IsInf(width, 0) && width > 0 {
			clean["imageWidth"] = strconv.FormatFloat(math.Min(width, 100), 'f', -1, 64)
		}
	case "file":
		keep("name")
		if id := publicFileID(props["fileId"]); id != "" {
			clean["fileId"] = id
		}
		if size, err := strconv.ParseUint(props["size"], 10, 53); err == nil {
			clean["size"] = strconv.FormatUint(size, 10)
		}
	case "video":
		keep("url", "name")
	case "bookmark":
		keep("url", "name", "title")
	case "flowchart":
		// Do not silently break existing public boards until their nested
		// node and mind-map metadata has a matching semantic projection.
		clean = make(map[string]string, len(props))
		for key, value := range props {
			if !strings.HasPrefix(key, "tbl.") && key != "tableData" && key != "tableMerges" && key != "tableWidths" && key != "tableHeader" && key != "tableHeaderColumn" {
				clean[key] = value
			}
		}
	}
	block.Props = clean
	switch block.Type {
	case "image", "file", "video", "bookmark", "flowchart", "divider", "columns":
		// These renderers do not display the block's text, which may be left
		// over after a type conversion. Child blocks are handled separately.
		block.Spans = []collab.Span{}
	case "math", "diagram":
		// Their source text is rendered, but inline marks are ignored.
		spans := make([]collab.Span, len(block.Spans))
		for i, span := range block.Spans {
			spans[i] = collab.Span{Text: span.Text, Marks: map[string]string{}}
		}
		block.Spans = spans
	default:
		spans := make([]collab.Span, len(block.Spans))
		for i, span := range block.Spans {
			spans[i] = collab.Span{Text: span.Text, Marks: publicTextMarks(span.Marks)}
		}
		block.Spans = spans
	}
	return block
}

func publicTextMarks(marks map[string]string) map[string]string {
	out := map[string]string{}
	if mathSource := marks["math"]; mathSource != "" {
		out["math"] = mathSource
		if validPublicCharID(marks["mathId"]) {
			out["mathId"] = marks["mathId"]
		}
		return out
	}
	for _, key := range []string{"bold", "italic", "underline", "strike", "code"} {
		if marks[key] != "" {
			out[key] = "true"
		}
	}
	for _, key := range []string{"color", "bg"} {
		if publicTextColor.MatchString(marks[key]) {
			out[key] = marks[key]
		}
	}
	if publicSafeLink(marks["link"]) {
		out["link"] = marks["link"]
	}
	if value, err := strconv.ParseUint(marks["mention"], 10, 53); err == nil && value > 0 {
		out["mention"] = strconv.FormatUint(value, 10)
	}
	return out
}

func publicFileID(raw string) string {
	id, err := strconv.ParseUint(raw, 10, 53)
	if err != nil || id == 0 || strconv.FormatUint(id, 10) != raw {
		return ""
	}
	return raw
}

func validPublicCharID(raw string) bool {
	if !publicCharID.MatchString(raw) {
		return false
	}
	client, clock, _ := strings.Cut(raw, ":")
	_, clientErr := strconv.ParseUint(client, 10, 53)
	_, clockErr := strconv.ParseUint(clock, 10, 53)
	return clientErr == nil && clockErr == nil
}

func publicSafeLink(value string) bool {
	if value == "" {
		return false
	}
	if strings.HasPrefix(value, "#/doc/") {
		return true
	}
	u, err := url.Parse(value)
	return err == nil && (strings.EqualFold(u.Scheme, "http") || strings.EqualFold(u.Scheme, "https")) && u.Host != ""
}

// Column width metadata may retain entries for deleted children. The
// renderer ignores those entries, so omit them from the exported view.
func publicColumnWidths(raw string, children map[string]bool) string {
	if raw == "" || len(raw) > 32000 {
		return ""
	}
	var widths map[string]float64
	if json.Unmarshal([]byte(raw), &widths) != nil || widths == nil || len(widths) > 1000 {
		return ""
	}
	var total float64
	visible := make(map[string]int64)
	for id, weight := range widths {
		if !validPublicCharID(id) || math.IsNaN(weight) || math.IsInf(weight, 0) || math.Trunc(weight) != weight || weight < 1 || weight > 1000000000 {
			return ""
		}
		total += weight
		if total > 1000000000 {
			return ""
		}
		if children[id] {
			visible[id] = int64(weight)
		}
	}
	if len(visible) == 0 {
		return ""
	}
	data, _ := json.Marshal(visible)
	return string(data)
}
