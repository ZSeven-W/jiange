package api

import (
	"encoding/json"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
)

var publicTextColor = regexp.MustCompile(`^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$`)
var publicCharID = regexp.MustCompile(`^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$`)
var publicShareLink = regexp.MustCompile(`^#/(s|p)/[A-Za-z0-9_-]{1,256}$`)
var publicInternalFileURL = regexp.MustCompile(`^/api/files/[1-9][0-9]*(\?version=[1-9][0-9]*)?$`)
var publicPollVoteKey = regexp.MustCompile(`^vote\.[A-Za-z0-9_-]{1,64}$`)
var publicShortID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,40}$`)

// publicCommonBlock projects properties used by public and saved-version
// renderers, including the semantic projection of flowchart registers.
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
		if publicSafeImageURL(props["url"]) {
			clean["url"] = props["url"]
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
	case "audio", "video":
		if publicSafeMediaURL(props["url"]) {
			clean["url"] = props["url"]
		}
		if id := publicFileID(props["fileId"]); id != "" {
			clean["fileId"] = id
		}
		keep("name", "title")
	case "poll":
		keep("question")
		if props["multiple"] == "true" || props["multiple"] == "false" {
			clean["multiple"] = props["multiple"]
		}
		var validOpts map[string]bool
		if opts, ids := publicPollOptions(props["options"]); opts != "" {
			clean["options"] = opts
			validOpts = ids
		}
		for key, val := range props {
			if !publicPollVoteKey.MatchString(key) {
				continue
			}
			if sanitized := publicPollVoteValue(val, validOpts); sanitized != "" {
				clean[key] = sanitized
			}
		}
	case "countdown":
		keep("title")
		if targetAt := publicCountdownTarget(props["targetAt"]); targetAt != "" {
			clean["targetAt"] = targetAt
		}
		switch props["theme"] {
		case "blue", "orange", "green", "purple":
			clean["theme"] = props["theme"]
		}
	case "tabs":
		if tabs := publicTabsJSON(props["tabs"]); tabs != "" {
			clean["tabs"] = tabs
		}
	case "bookmark":
		keep("url", "name", "title")
	case "embed":
		switch props["resourceKind"] {
		case "sheet", "base", "survey", "slides":
			clean["resourceKind"] = props["resourceKind"]
		}
		if id := publicFileID(props["resourceId"]); id != "" {
			clean["resourceId"] = id
		}
		keep("title")
	case "reminder":
		keep("date", "time", "label")
		if props["done"] == "true" {
			clean["done"] = "true"
		}
	case "synced":
		keep("syncId")
	case "flowchart":
		clean = publicFlowProps(props)
	}
	block.Props = clean
	switch block.Type {
	case "image", "file", "video", "audio", "poll", "countdown", "tabs", "bookmark", "flowchart", "divider", "columns", "embed", "reminder", "synced", "subpages":
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
		if marks["linkKind"] == "text" || marks["linkKind"] == "reference" {
			out["linkKind"] = marks["linkKind"]
		}
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
	if id, _ := resourceReferenceTarget(value); id > 0 {
		return true
	}
	if publicShareLink.MatchString(value) {
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

func publicSafeMediaURL(value string) bool {
	if value == "" {
		return false
	}
	return publicInternalFileURL.MatchString(value) || publicSafeLink(value)
}

func publicSafeImageURL(value string) bool {
	if value == "" {
		return false
	}
	if publicInternalFileURL.MatchString(value) {
		return true
	}
	u, err := url.Parse(value)
	return err == nil && (strings.EqualFold(u.Scheme, "http") || strings.EqualFold(u.Scheme, "https")) && u.Host != ""
}

type publicPollOption struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}

func publicPollOptions(raw string) (string, map[string]bool) {
	if raw == "" || len(raw) > 64000 {
		return "", nil
	}
	var items []publicPollOption
	if json.Unmarshal([]byte(raw), &items) != nil || len(items) == 0 {
		return "", nil
	}
	seen := make(map[string]bool, len(items))
	out := make([]publicPollOption, 0, len(items))
	for i, item := range items {
		if len(out) >= 30 {
			break
		}
		id := item.ID
		if !publicShortID.MatchString(id) {
			id = "opt-" + strconv.Itoa(i+1)
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, publicPollOption{ID: id, Text: item.Text})
	}
	if len(out) == 0 {
		return "", nil
	}
	data, _ := json.Marshal(out)
	return string(data), seen
}

func publicPollVoteValue(raw string, validIDs map[string]bool) string {
	if raw == "" || len(raw) > 2048 {
		return ""
	}
	seen := map[string]bool{}
	var out []string
	for _, part := range strings.Split(raw, ",") {
		id := strings.TrimSpace(part)
		if id == "" || !publicShortID.MatchString(id) || seen[id] {
			continue
		}
		if len(validIDs) > 0 && !validIDs[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return strings.Join(out, ",")
}

func publicCountdownTarget(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || len(trimmed) > 64 {
		return ""
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05", "2006-01-02T15:04"} {
		if _, err := time.Parse(layout, trimmed); err == nil {
			return trimmed
		}
	}
	return ""
}

type publicTabItem struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Content string `json:"content"`
}

func publicTabsJSON(raw string) string {
	if raw == "" || len(raw) > 256000 {
		return ""
	}
	var items []publicTabItem
	if json.Unmarshal([]byte(raw), &items) != nil || len(items) == 0 {
		return ""
	}
	seen := make(map[string]bool, len(items))
	out := make([]publicTabItem, 0, len(items))
	for i, item := range items {
		if len(out) >= 20 {
			break
		}
		id := item.ID
		if !publicShortID.MatchString(id) {
			id = "tab-" + strconv.Itoa(i+1)
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, publicTabItem{ID: id, Label: item.Label, Content: item.Content})
	}
	if len(out) == 0 {
		return ""
	}
	data, _ := json.Marshal(out)
	return string(data)
}
