package api

import (
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
)

var publicFlowID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,40}$`)
var publicMindID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
var publicFlowColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// publicFlowProps mirrors the whiteboard SDK's visible graph semantics. It
// rewrites objects rather than forwarding arbitrary embedded JSON, and omits
// edges and mind metadata whose owner is not a live, renderable object.
func publicFlowProps(props map[string]string) map[string]string {
	out := map[string]string{}
	if props["align"] == "center" || props["align"] == "right" {
		out["align"] = props["align"]
	}
	if indent, ok := publicNumberString(props["indent"]); ok && math.Trunc(indent) == indent && indent >= 0 && indent <= 20 {
		out["indent"] = props["indent"]
	}
	if h, ok := publicNumberString(props["fc.h"]); ok && h != 0 {
		out["fc.h"] = numberString(math.Max(200, math.Min(1200, h)))
	}
	switch props["fc.theme"] {
	case "feishu", "classic", "minimal", "colorful", "sketch", "dark", "business":
		out["fc.theme"] = props["fc.theme"]
	}
	nodes := map[string]bool{}
	for key, raw := range props {
		if !strings.HasPrefix(key, "fc.n.") || raw == "" {
			continue
		}
		id := strings.TrimPrefix(key, "fc.n.")
		if !publicFlowID.MatchString(id) {
			continue
		}
		if node := publicFlowNode(raw); node != nil {
			out[key] = publicJSON(node)
			nodes[id] = true
		}
	}
	for key, raw := range props {
		if raw == "" {
			continue
		}
		switch {
		case strings.HasPrefix(key, "fc.e."):
			id := strings.TrimPrefix(key, "fc.e.")
			if !publicFlowID.MatchString(id) {
				continue
			}
			if edge := publicFlowEdge(raw, nodes); edge != nil {
				out[key] = publicJSON(edge)
			}
		case strings.HasPrefix(key, "fc.s."):
			id := strings.TrimPrefix(key, "fc.s.")
			if !publicFlowID.MatchString(id) {
				continue
			}
			if stroke := publicFlowStroke(raw); stroke != nil {
				out[key] = publicJSON(stroke)
				if props["fc.marker."+id] == "1" {
					out["fc.marker."+id] = "1"
				}
			}
		}
	}
	publicMindProps(out, props)
	return out
}

func publicJSONObject(raw string) map[string]any {
	if len(raw) > 8<<20 {
		return nil
	}
	var m map[string]any
	if json.Unmarshal([]byte(raw), &m) != nil {
		return nil
	}
	return m
}

func publicJSON(value any) string { data, _ := json.Marshal(value); return string(data) }

func publicNumber(value any) (float64, bool) {
	n, ok := value.(float64)
	return n, ok && !math.IsNaN(n) && !math.IsInf(n, 0)
}
func publicNumberString(value string) (float64, bool) {
	n, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	return n, err == nil && !math.IsNaN(n) && !math.IsInf(n, 0)
}
func numberString(value float64) string { return strconv.FormatFloat(value, 'f', -1, 64) }
func publicBounded(value any, min, max, def float64) float64 {
	if n, ok := publicNumber(value); ok {
		return math.Max(min, math.Min(max, n))
	}
	return def
}
func publicJSRound(n float64) float64 { return math.Floor(n + 0.5) }

func publicUTF16Prefix(value string, limit int) string {
	chars := utf16.Encode([]rune(value))
	if len(chars) > limit {
		chars = chars[:limit]
	}
	return string(utf16.Decode(chars))
}

func publicFlowNode(raw string) map[string]any {
	m := publicJSONObject(raw)
	if m == nil {
		// JavaScript treats arrays as objects; with no named fields they
		// render as a default rectangle rather than an absent node.
		var list []any
		if len(raw) > 8<<20 || json.Unmarshal([]byte(raw), &list) != nil || list == nil {
			return nil
		}
		m = map[string]any{}
	}
	shape, _ := m["shape"].(string)
	switch shape {
	case "rect", "round", "diamond", "ellipse", "terminator", "parallelogram", "document", "cylinder", "hexagon", "text", "triangle", "note", "swimlane", "swimlaneV", "class", "actor", "lifeline", "image":
	default:
		shape = "rect"
	}
	text, _ := m["text"].(string)
	if shape == "image" {
		text = ""
	}
	out := map[string]any{"shape": shape, "x": publicBounded(m["x"], -20000, 20000, 0), "y": publicBounded(m["y"], -20000, 20000, 0), "w": publicBounded(m["w"], 20, 2000, 140), "h": publicBounded(m["h"], 16, 2000, 60), "text": publicUTF16Prefix(text, 500)}
	for _, key := range []string{"fill", "stroke", "color"} {
		if v, ok := m[key].(string); ok && publicFlowColor.MatchString(v) {
			out[key] = v
		}
	}
	if n, ok := publicNumber(m["size"]); ok && n >= 10 && n <= 48 {
		out["size"] = publicJSRound(n)
	}
	if v, ok := m["align"].(string); ok && (v == "left" || v == "right") {
		out["align"] = v
	}
	if shape == "image" {
		if n, ok := publicNumber(m["fileId"]); ok && n > 0 && n <= 1<<53-1 && math.Trunc(n) == n {
			out["fileId"] = n
		}
	}
	if n, ok := publicNumber(m["rot"]); ok {
		v := math.Mod(n, 360)
		if v < 0 {
			v += 360
		}
		v = math.Mod(publicJSRound(v), 360)
		if v != 0 {
			out["rot"] = v
		}
	}
	if n, ok := publicNumber(m["z"]); ok {
		out["z"] = n
	}
	return out
}

func publicFlowEdge(raw string, nodes map[string]bool) map[string]any {
	m := publicJSONObject(raw)
	if m == nil {
		return nil
	}
	from, ok1 := m["from"].(string)
	to, ok2 := m["to"].(string)
	if !ok1 || !ok2 || !publicFlowID.MatchString(from) || !publicFlowID.MatchString(to) || !nodes[from] || !nodes[to] {
		return nil
	}
	out := map[string]any{"from": from, "to": to}
	for _, key := range []string{"fromPort", "toPort"} {
		if v, ok := m[key].(string); ok && (v == "top" || v == "right" || v == "bottom" || v == "left") {
			out[key] = v
		}
	}
	if v, ok := m["label"].(string); ok && v != "" {
		out["label"] = publicUTF16Prefix(v, 200)
	}
	if v, ok := m["kind"].(string); ok && (v == "straight" || v == "curve") {
		out["kind"] = v
	}
	if v, ok := m["dashed"].(bool); ok && v {
		out["dashed"] = true
	}
	if v, ok := m["color"].(string); ok && publicFlowColor.MatchString(v) {
		out["color"] = v
	}
	if v, ok := m["arrow"].(string); ok && (v == "both" || v == "none") {
		out["arrow"] = v
	}
	if n, ok := publicNumber(m["mid"]); ok {
		out["mid"] = publicJSRound(math.Max(-40000, math.Min(40000, n)))
	}
	if pts, ok := m["pts"].([]any); ok {
		clean := []any{}
		for i, p := range pts {
			if i >= 20 {
				break
			}
			v, ok := p.(map[string]any)
			if !ok {
				continue
			}
			x, xok := publicNumber(v["x"])
			y, yok := publicNumber(v["y"])
			if !xok || !yok {
				continue
			}
			clean = append(clean, map[string]any{"x": publicJSRound(math.Max(-40000, math.Min(40000, x))), "y": publicJSRound(math.Max(-40000, math.Min(40000, y)))})
		}
		if len(clean) > 0 {
			out["pts"] = clean
		}
	}
	return out
}

func publicFlowStroke(raw string) map[string]any {
	m := publicJSONObject(raw)
	if m == nil {
		return nil
	}
	color, ok := m["color"].(string)
	width, wok := publicNumber(m["width"])
	points, pok := m["points"].([]any)
	if !ok || !publicFlowColor.MatchString(color) || !wok || width < 1 || width > 24 || !pok || len(points) < 1 || len(points) > 400 {
		return nil
	}
	out := make([]any, 0, len(points))
	for _, p := range points {
		v, ok := p.(map[string]any)
		if !ok {
			return nil
		}
		x, xok := publicNumber(v["x"])
		y, yok := publicNumber(v["y"])
		if !xok || !yok || math.Abs(x) > 20000 || math.Abs(y) > 20000 {
			return nil
		}
		out = append(out, map[string]any{"x": publicJSRound(x), "y": publicJSRound(y)})
	}
	return map[string]any{"color": color, "width": width, "points": out}
}
