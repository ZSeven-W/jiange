package api

import (
	"encoding/json"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

var publicFlowID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,40}$`)
var publicMindID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
var publicFlowColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
var publicVoterID = regexp.MustCompile(`^[A-Za-z0-9_:@.-]{1,64}$`)

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
	switch props["fc.ml"] {
	case "logic", "org", "fishbone", "timeline":
		out["fc.ml"] = props["fc.ml"]
	}
	nodes := map[string]bool{}
	frameKeys := []string{}
	for key, raw := range props {
		if raw == "" {
			continue
		}
		if strings.HasPrefix(key, "fc.fr.") {
			frameKeys = append(frameKeys, key)
			continue
		}
		if !strings.HasPrefix(key, "fc.n.") {
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
	sort.Strings(frameKeys)
	frameCount := 0
	for _, key := range frameKeys {
		if frameCount >= 100 {
			break
		}
		id := strings.TrimPrefix(key, "fc.fr.")
		if !publicFlowID.MatchString(id) {
			continue
		}
		if frame := publicBoardFrame(id, props[key]); frame != nil {
			out[key] = publicJSON(frame)
			frameCount++
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
	publicBoardVotesProps(out, props, nodes)
	publicMindProps(out, props)
	publicMindRelationProps(out, props)
	publicMindExtrasProps(out, props)
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
	case "rect", "round", "diamond", "ellipse", "terminator", "parallelogram", "document", "cylinder", "hexagon", "text", "triangle", "note", "sticky", "swimlane", "swimlaneV", "class", "actor", "lifeline", "image":
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

func publicBoardFrame(id, raw string) map[string]any {
	if len(raw) > 4096 {
		return nil
	}
	m := publicJSONObject(raw)
	if m == nil {
		return nil
	}
	if rawID, exists := m["id"]; exists {
		s, ok := rawID.(string)
		if !ok || s != id {
			return nil
		}
	}
	x, xok := publicNumber(m["x"])
	y, yok := publicNumber(m["y"])
	w, wok := publicNumber(m["w"])
	h, hok := publicNumber(m["h"])
	if !xok || !yok || !wok || !hok {
		return nil
	}
	if math.Abs(x) > 20000 || math.Abs(y) > 20000 || w < 160 || w > 8000 || h < 120 || h > 8000 {
		return nil
	}
	title := "Frame"
	if rawTitle, exists := m["title"]; exists && rawTitle != nil {
		t, ok := rawTitle.(string)
		if !ok || strings.ContainsRune(t, 0) || len(utf16.Encode([]rune(t))) > 120 {
			return nil
		}
		if trimmed := strings.TrimSpace(t); trimmed != "" {
			title = trimmed
		}
	}
	out := map[string]any{
		"id":    id,
		"title": title,
		"x":     publicJSRound(x),
		"y":     publicJSRound(y),
		"w":     publicJSRound(w),
		"h":     publicJSRound(h),
	}
	if bg, ok := m["bg"].(string); ok && publicFlowColor.MatchString(bg) {
		out["bg"] = bg
	}
	return out
}

func publicMindRelationProps(out, props map[string]string) {
	liveTopics := map[string]bool{}
	for key, val := range out {
		if strings.HasPrefix(key, "fc.m.") && val != "" {
			liveTopics[strings.TrimPrefix(key, "fc.m.")] = true
		}
	}
	if len(liveTopics) == 0 {
		return
	}
	relKeys := []string{}
	for key, raw := range props {
		if strings.HasPrefix(key, "fc.mr.") && raw != "" {
			relKeys = append(relKeys, key)
		}
	}
	sort.Strings(relKeys)
	count := 0
	for _, key := range relKeys {
		if count >= 200 {
			break
		}
		id := strings.TrimPrefix(key, "fc.mr.")
		if !publicFlowID.MatchString(id) {
			continue
		}
		if rel := publicMindRelation(id, props[key], liveTopics); rel != nil {
			out[key] = publicJSON(rel)
			count++
		}
	}
}

func publicMindRelation(id, raw string, liveTopics map[string]bool) map[string]any {
	if len(raw) > 2048 {
		return nil
	}
	m := publicJSONObject(raw)
	if m == nil {
		return nil
	}
	if rawID, exists := m["id"]; exists {
		s, ok := rawID.(string)
		if !ok || s != id {
			return nil
		}
	}
	fromID, ok1 := m["fromId"].(string)
	toID, ok2 := m["toId"].(string)
	if !ok1 || !ok2 || fromID == toID || !publicMindID.MatchString(fromID) || !publicMindID.MatchString(toID) || !liveTopics[fromID] || !liveTopics[toID] {
		return nil
	}
	out := map[string]any{
		"id":     id,
		"fromId": fromID,
		"toId":   toID,
	}
	if rawLabel, exists := m["label"]; exists && rawLabel != nil {
		label, ok := rawLabel.(string)
		if !ok || strings.ContainsRune(label, 0) || len(utf16.Encode([]rune(label))) > 80 {
			return nil
		}
		if trimmed := strings.TrimSpace(label); trimmed != "" {
			out["label"] = trimmed
		}
	}
	return out
}

func publicBoardVotesProps(out, props map[string]string, nodes map[string]bool) {
	if len(nodes) == 0 {
		return
	}
	voteKeys := []string{}
	for key, raw := range props {
		if strings.HasPrefix(key, "fc.vt.") && raw != "" {
			voteKeys = append(voteKeys, key)
		}
	}
	sort.Strings(voteKeys)
	count := 0
	for _, key := range voteKeys {
		if count >= 200 {
			break
		}
		id := strings.TrimPrefix(key, "fc.vt.")
		if !publicFlowID.MatchString(id) || !nodes[id] {
			continue
		}
		if vote := publicBoardVote(props[key]); vote != nil {
			out[key] = publicJSON(vote)
			count++
		}
	}
}

func publicBoardVote(raw string) map[string]any {
	if len(raw) > 16384 {
		return nil
	}
	m := publicJSONObject(raw)
	if m == nil {
		return nil
	}
	rawVoters, ok := m["voters"].([]any)
	if !ok {
		return nil
	}
	seen := map[string]bool{}
	voters := make([]string, 0, len(rawVoters))
	for _, item := range rawVoters {
		if len(voters) >= 500 {
			break
		}
		s, ok := item.(string)
		if !ok || strings.ContainsRune(s, 0) {
			continue
		}
		trimmed := strings.TrimSpace(s)
		if !publicVoterID.MatchString(trimmed) || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		voters = append(voters, trimmed)
	}
	if len(voters) == 0 {
		return nil
	}
	sort.Strings(voters)
	return map[string]any{"voters": voters}
}

func publicMindExtrasProps(out, props map[string]string) {
	liveTopics := map[string]bool{}
	for key, val := range out {
		if strings.HasPrefix(key, "fc.m.") && val != "" {
			liveTopics[strings.TrimPrefix(key, "fc.m.")] = true
		}
	}
	if len(liveTopics) == 0 {
		return
	}
	boundaryKeys := []string{}
	summaryKeys := []string{}
	badgeKeys := []string{}
	for key, raw := range props {
		if raw == "" {
			continue
		}
		switch {
		case strings.HasPrefix(key, "fc.mb."):
			boundaryKeys = append(boundaryKeys, key)
		case strings.HasPrefix(key, "fc.msu."):
			summaryKeys = append(summaryKeys, key)
		case strings.HasPrefix(key, "fc.mg."):
			badgeKeys = append(badgeKeys, key)
		}
	}
	sort.Strings(boundaryKeys)
	sort.Strings(summaryKeys)
	sort.Strings(badgeKeys)

	bCount := 0
	for _, key := range boundaryKeys {
		if bCount >= 200 {
			break
		}
		id := strings.TrimPrefix(key, "fc.mb.")
		if !publicMindID.MatchString(id) || !liveTopics[id] {
			continue
		}
		if boundary := publicMindBoundary(props[key]); boundary != nil {
			out[key] = publicJSON(boundary)
			bCount++
		}
	}

	sCount := 0
	for _, key := range summaryKeys {
		if sCount >= 200 {
			break
		}
		id := strings.TrimPrefix(key, "fc.msu.")
		if !publicMindID.MatchString(id) || !liveTopics[id] {
			continue
		}
		if summary := publicMindSummary(props[key]); summary != nil {
			out[key] = publicJSON(summary)
			sCount++
		}
	}

	gCount := 0
	for _, key := range badgeKeys {
		if gCount >= 500 {
			break
		}
		id := strings.TrimPrefix(key, "fc.mg.")
		if !publicMindID.MatchString(id) || !liveTopics[id] {
			continue
		}
		if badge := publicMindBadge(props[key]); badge != nil {
			out[key] = publicJSON(badge)
			gCount++
		}
	}
}

func publicMindBoundary(raw string) map[string]any {
	if len(raw) > 1024 {
		return nil
	}
	m := publicJSONObject(raw)
	if m == nil {
		return nil
	}
	color := "#3370ff"
	if rawColor, exists := m["color"]; exists && rawColor != nil {
		c, ok := rawColor.(string)
		if !ok || !publicFlowColor.MatchString(c) {
			return nil
		}
		color = strings.ToLower(c)
	}
	out := map[string]any{"color": color}
	if rawLabel, exists := m["label"]; exists && rawLabel != nil {
		label, ok := rawLabel.(string)
		if !ok || strings.ContainsRune(label, 0) || len(utf16.Encode([]rune(label))) > 40 {
			return nil
		}
		if trimmed := strings.TrimSpace(label); trimmed != "" {
			out["label"] = trimmed
		}
	}
	return out
}

func publicMindSummary(raw string) map[string]any {
	if len(raw) > 1024 {
		return nil
	}
	m := publicJSONObject(raw)
	if m == nil {
		return nil
	}
	color := "#722ed1"
	if rawColor, exists := m["color"]; exists && rawColor != nil {
		c, ok := rawColor.(string)
		if !ok || !publicFlowColor.MatchString(c) {
			return nil
		}
		color = strings.ToLower(c)
	}
	label := "概要"
	if rawLabel, exists := m["label"]; exists && rawLabel != nil {
		s, ok := rawLabel.(string)
		if !ok || strings.ContainsRune(s, 0) || len(utf16.Encode([]rune(s))) > 80 {
			return nil
		}
		if trimmed := strings.TrimSpace(s); trimmed != "" {
			label = trimmed
		}
	}
	return map[string]any{"label": label, "color": color}
}

func publicMindBadge(raw string) map[string]any {
	if len(raw) > 1024 {
		return nil
	}
	m := publicJSONObject(raw)
	if m == nil {
		return nil
	}
	out := map[string]any{}
	if rawP, exists := m["priority"]; exists && rawP != nil {
		n, ok := publicNumber(rawP)
		if !ok || math.Trunc(n) != n || (n != 1 && n != 2 && n != 3) {
			return nil
		}
		out["priority"] = int(n)
	}
	if rawProg, exists := m["progress"]; exists && rawProg != nil {
		n, ok := publicNumber(rawProg)
		if !ok || math.Trunc(n) != n || (n != 0 && n != 25 && n != 50 && n != 75 && n != 100) {
			return nil
		}
		out["progress"] = int(n)
	}
	if rawTag, exists := m["tag"]; exists && rawTag != nil {
		s, ok := rawTag.(string)
		if !ok || strings.ContainsRune(s, 0) || len(utf16.Encode([]rune(s))) > 16 {
			return nil
		}
		if trimmed := strings.TrimSpace(s); trimmed != "" {
			out["tag"] = trimmed
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
