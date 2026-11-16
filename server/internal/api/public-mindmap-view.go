package api

import (
	"encoding/json"
	"math"
	"strings"
	"unicode/utf16"
)

type publicTopic struct {
	parent *string
	value  map[string]any
}

func publicMindProps(out, props map[string]string) {
	topics := map[string]publicTopic{}
	for key, raw := range props {
		if !strings.HasPrefix(key, "fc.m.") || raw == "" {
			continue
		}
		id := strings.TrimPrefix(key, "fc.m.")
		if !publicMindID.MatchString(id) {
			continue
		}
		if topic, ok := publicMindTopic(id, raw); ok {
			topics[id] = topic
		}
	}
	for id, topic := range topics {
		seen := map[string]bool{}
		current := id
		valid := true
		depth := 0
		for {
			t, exists := topics[current]
			if !exists {
				valid = false
				break
			}
			if t.parent == nil {
				break
			}
			if seen[current] {
				valid = false
				break
			}
			seen[current] = true
			depth++
			if depth > 32 {
				valid = false
				break
			}
			current = *t.parent
		}
		if !valid {
			continue
		}
		out["fc.m."+id] = publicJSON(topic.value)
		if props["fc.mc."+id] == "1" {
			out["fc.mc."+id] = "1"
		}
		for _, kind := range []string{"ms", "mp", "mt", "mds"} {
			key := "fc." + kind + "." + id
			if style := publicMindStyle(kind, props[key]); style != nil {
				out[key] = publicJSON(style)
			}
		}
		key := "fc.md." + id
		if text := publicMindDescription(props[key]); text != "" {
			out[key] = publicJSON(text)
		}
	}
}

func publicMindTopic(id, raw string) (publicTopic, bool) {
	m := publicJSONObject(raw)
	if m == nil {
		return publicTopic{}, false
	}
	p, exists := m["parent"]
	if !exists {
		return publicTopic{}, false
	}
	var parent *string
	if p != nil {
		v, ok := p.(string)
		if !ok || !publicMindID.MatchString(v) || v == id {
			return publicTopic{}, false
		}
		parent = &v
	}
	text, ok := m["text"].(string)
	order, numberOK := publicNumber(m["order"])
	if !ok || len(utf16.Encode([]rune(text))) > 500 || strings.ContainsRune(text, 0) || !numberOK || order < 0 || order > 1000000 {
		return publicTopic{}, false
	}
	value := map[string]any{"parent": p, "text": text, "order": order}
	if parent == nil {
		x, xok := publicNumber(m["x"])
		y, yok := publicNumber(m["y"])
		if !xok || !yok || math.Abs(x) > 20000 || math.Abs(y) > 20000 {
			return publicTopic{}, false
		}
		value["x"], value["y"] = publicJSRound(x), publicJSRound(y)
	}
	return publicTopic{parent: parent, value: value}, true
}

func publicMindDescription(raw string) string {
	if raw == "" || len(raw) > 1<<20 {
		return ""
	}
	var text string
	if json.Unmarshal([]byte(raw), &text) != nil || len(utf16.Encode([]rune(text))) > 2000 || strings.ContainsRune(text, 0) {
		return ""
	}
	lines := 0
	for _, paragraph := range strings.Split(text, "\n") {
		width := 0.0
		has := false
		for _, r := range paragraph {
			advance := 12.0 * 0.58
			if r >= 0x2e80 {
				advance = 12
			}
			if has && width+advance > 288 {
				lines++
				width = 0
				has = false
			}
			width += advance
			has = true
		}
		lines++
		if lines > 128 {
			return ""
		}
	}
	return text
}

func publicMindStyle(kind, raw string) map[string]any {
	if raw == "" {
		return nil
	}
	m := publicJSONObject(raw)
	if m == nil {
		return nil
	}
	allowed := map[string]bool{}
	switch kind {
	case "ms":
		for _, k := range []string{"shape", "size", "color"} {
			allowed[k] = true
		}
	case "mp":
		for _, k := range []string{"fill", "fillOpacity", "stroke", "line", "width", "opacity"} {
			allowed[k] = true
		}
	case "mt":
		for _, k := range []string{"bold", "italic", "underline", "strike", "highlight", "align"} {
			allowed[k] = true
		}
	case "mds":
		for _, k := range []string{"size", "color", "highlight"} {
			allowed[k] = true
		}
	default:
		return nil
	}
	for key := range m {
		if !allowed[key] {
			return nil
		}
	}
	out := map[string]any{}
	for key, value := range m {
		switch key {
		case "shape":
			v, ok := value.(string)
			if !ok || v != "text" && v != "oval" && v != "rect" {
				return nil
			}
			out[key] = v
		case "line":
			v, ok := value.(string)
			if !ok || v != "solid" && v != "dashed" && v != "dotted" {
				return nil
			}
			out[key] = v
		case "align":
			v, ok := value.(string)
			if !ok || v != "left" && v != "center" && v != "right" {
				return nil
			}
			out[key] = v
		case "bold", "italic", "underline", "strike":
			v, ok := value.(bool)
			if !ok || !v {
				return nil
			}
			out[key] = true
		case "color", "stroke", "highlight", "fill":
			v, ok := value.(string)
			if !ok || !(key == "fill" && v == "none") && !publicFlowColor.MatchString(v) {
				return nil
			}
			out[key] = strings.ToLower(v)
		case "size", "width", "opacity", "fillOpacity":
			n, ok := publicNumber(value)
			if !ok || math.Trunc(n) != n {
				return nil
			}
			if key == "size" && (n < 12 || n > 96) || key == "width" && (n < 1 || n > 4) || (key == "opacity" || key == "fillOpacity") && (n < 0 || n > 100) {
				return nil
			}
			out[key] = n
		}
	}
	return out
}
