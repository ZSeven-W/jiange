package api

import (
	"encoding/json"
	"math"
	"regexp"
	"strings"
	"unicode/utf16"
)

var searchableMindID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

type searchableMindNode struct {
	parent string
	text   string
}

// Only search topics that the client can render from a valid root. Orphaned,
// malformed and cyclic properties must not become invisible search results.
func collectSearchableMindTopics(props map[string]string) []string {
	nodes := make(map[string]searchableMindNode)
	for key, raw := range props {
		if !strings.HasPrefix(key, "fc.m.") || raw == "" {
			continue
		}
		id := strings.TrimPrefix(key, "fc.m.")
		if !searchableMindID.MatchString(id) {
			continue
		}
		var fields map[string]json.RawMessage
		if json.Unmarshal([]byte(raw), &fields) != nil || fields == nil {
			continue
		}
		parentRaw, exists := fields["parent"]
		if !exists {
			continue
		}
		var parent, text string
		var order float64
		if string(parentRaw) != "null" && (json.Unmarshal(parentRaw, &parent) != nil || !searchableMindID.MatchString(parent) || parent == id) {
			continue
		}
		if string(fields["text"]) == "null" || string(fields["order"]) == "null" || json.Unmarshal(fields["text"], &text) != nil || len(utf16.Encode([]rune(text))) > 500 || strings.ContainsRune(text, '\x00') || json.Unmarshal(fields["order"], &order) != nil || math.IsNaN(order) || math.IsInf(order, 0) || order < 0 || order > 1000000 {
			continue
		}
		if parent == "" {
			var x, y float64
			if string(fields["x"]) == "null" || string(fields["y"]) == "null" || json.Unmarshal(fields["x"], &x) != nil || json.Unmarshal(fields["y"], &y) != nil || math.IsNaN(x) || math.IsNaN(y) || math.IsInf(x, 0) || math.IsInf(y, 0) || math.Abs(x) > 20000 || math.Abs(y) > 20000 {
				continue
			}
		}
		nodes[id] = searchableMindNode{parent: parent, text: text}
	}
	var out []string
	for id, node := range nodes {
		seen := make(map[string]bool)
		current := id
		depth := 0
		for {
			n, ok := nodes[current]
			if !ok || seen[current] {
				break
			}
			seen[current] = true
			if n.parent == "" {
				out = append(out, node.text)
				break
			}
			depth++
			if depth > 32 {
				break
			}
			current = n.parent
		}
	}
	return out
}

func searchableMindTopics(props map[string]string, contains func(string) bool) bool {
	for _, topic := range collectSearchableMindTopics(props) {
		if contains(topic) {
			return true
		}
	}
	return false
}
