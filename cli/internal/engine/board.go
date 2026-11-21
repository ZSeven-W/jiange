package engine

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// BoardNode represents a flowchart node or mind map topic.
type BoardNode struct {
	ID    string `json:"id"`
	Text  string `json:"text"`
	Shape string `json:"shape"`
	X     int    `json:"x"`
	Y     int    `json:"y"`
}

// BoardEdge represents a directed connection between two nodes.
type BoardEdge struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Label string `json:"label,omitempty"`
}

// BoardData is the pure-Go headless whiteboard model.
type BoardData struct {
	Nodes []BoardNode `json:"nodes"`
	Edges []BoardEdge `json:"edges"`
}

// BoardDiag reports graph topology problems.
type BoardDiag struct {
	Code       string `json:"code"`
	Severity   string `json:"severity"`
	EntityID   string `json:"entityId,omitempty"`
	Message    string `json:"message"`
	Suggestion string `json:"suggestion"`
}

// LoadBoard loads a .mmd (Mermaid), .xmind, or .json whiteboard file.
func LoadBoard(path string) (*BoardData, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".xmind":
		return ParseXMind(raw)
	case ".json":
		var b BoardData
		if err := json.Unmarshal(raw, &b); err != nil {
			return nil, err
		}
		return &b, nil
	default:
		return ParseMermaidBoard(string(raw)), nil
	}
}

// ParseMermaidBoard parses Mermaid flowchart lines into BoardData.
func ParseMermaidBoard(code string) *BoardData {
	b := &BoardData{}
	seen := make(map[string]bool)
	ensure := func(tok string) string {
		tok = strings.TrimSpace(strings.TrimSuffix(tok, ";"))
		id := tok
		label := tok
		shape := "rect"
		for _, pair := range [][3]string{
			{"([", "])", "terminator"},
			{"{", "}", "diamond"},
			{"((", "))", "ellipse"},
			{"[", "]", "rect"},
			{"(", ")", "round"},
		} {
			if idx := strings.Index(tok, pair[0]); idx > 0 && strings.HasSuffix(tok, pair[1]) {
				id = strings.TrimSpace(tok[:idx])
				label = strings.Trim(tok[idx+len(pair[0]):len(tok)-len(pair[1])], `"`)
				shape = pair[2]
				break
			}
		}
		if id == "" {
			return ""
		}
		if !seen[id] {
			seen[id] = true
			n := len(b.Nodes)
			b.Nodes = append(b.Nodes, BoardNode{
				ID: id, Text: label, Shape: shape,
				X: 60 + (n%4)*210, Y: 60 + (n/4)*120,
			})
		}
		return id
	}
	for _, rawLine := range strings.Split(strings.ReplaceAll(code, "\r\n", "\n"), "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "%%") || strings.HasPrefix(strings.ToLower(line), "flowchart") || strings.HasPrefix(strings.ToLower(line), "graph") {
			continue
		}
		for _, arrow := range []string{"-->", "-.->", "---"} {
			if idx := strings.Index(line, arrow); idx > 0 {
				left := strings.TrimSpace(line[:idx])
				right := strings.TrimSpace(line[idx+len(arrow):])
				label := ""
				if strings.HasPrefix(right, "|") {
					if end := strings.Index(right[1:], "|"); end >= 0 {
						label = strings.TrimSpace(right[1 : end+1])
						right = strings.TrimSpace(right[end+2:])
					}
				}
				fromID := ensure(left)
				toID := ensure(right)
				if fromID != "" && toID != "" {
					b.Edges = append(b.Edges, BoardEdge{From: fromID, To: toID, Label: label})
				}
				goto nextLine
			}
		}
		ensure(line)
	nextLine:
	}
	return b
}

// ParseXMind reads content.json from an XMind ZEN .xmind archive into BoardData.
func ParseXMind(data []byte) (*BoardData, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("invalid xmind zip: %w", err)
	}
	var content []byte
	for _, f := range zr.File {
		if f.Name == "content.json" {
			rc, err := f.Open()
			if err != nil {
				return nil, err
			}
			content, err = io.ReadAll(io.LimitReader(rc, 8*1024*1024))
			rc.Close()
			if err != nil {
				return nil, err
			}
			break
		}
	}
	if len(content) == 0 {
		return nil, fmt.Errorf("content.json not found in xmind")
	}
	type xmTopic struct {
		ID       string `json:"id"`
		Title    string `json:"title"`
		Children struct {
			Attached []xmTopic `json:"attached"`
		} `json:"children"`
	}
	type xmSheet struct {
		RootTopic xmTopic `json:"rootTopic"`
	}
	var sheets []xmSheet
	if err := json.Unmarshal(content, &sheets); err != nil {
		return nil, err
	}
	b := &BoardData{}
	var walk func(t xmTopic, parentID string, depth int)
	walk = func(t xmTopic, parentID string, depth int) {
		id := t.ID
		if id == "" {
			id = fmt.Sprintf("m%d", len(b.Nodes)+1)
		}
		b.Nodes = append(b.Nodes, BoardNode{
			ID: id, Text: t.Title, Shape: "round",
			X: 60 + depth*220, Y: 60 + len(b.Nodes)*80,
		})
		if parentID != "" {
			b.Edges = append(b.Edges, BoardEdge{From: parentID, To: id})
		}
		for _, child := range t.Children.Attached {
			walk(child, id, depth+1)
		}
	}
	for _, sh := range sheets {
		walk(sh.RootTopic, "", 0)
	}
	return b, nil
}

// Inspect returns a compact summary of board nodes and edges.
func (b *BoardData) Inspect() map[string]any {
	return map[string]any{
		"nodeCount": len(b.Nodes),
		"edgeCount": len(b.Edges),
		"nodes":     b.Nodes,
		"edges":     b.Edges,
	}
}

// Verify detects empty board, dangling edges, and isolated nodes.
func (b *BoardData) Verify() []BoardDiag {
	var diags []BoardDiag
	if len(b.Nodes) == 0 {
		return []BoardDiag{{
			Code: "EMPTY_BOARD", Severity: "warning",
			Message: "Board contains 0 nodes.", Suggestion: "Add nodes and edges.",
		}}
	}
	nodeSet := make(map[string]bool, len(b.Nodes))
	deg := make(map[string]int, len(b.Nodes))
	for _, n := range b.Nodes {
		nodeSet[n.ID] = true
	}
	for _, e := range b.Edges {
		if !nodeSet[e.From] || !nodeSet[e.To] {
			diags = append(diags, BoardDiag{
				Code: "DANGLING_EDGE", Severity: "error",
				Message:    fmt.Sprintf("Edge %s -> %s references missing node.", e.From, e.To),
				Suggestion: "Remove the dangling edge or add the missing node.",
			})
			continue
		}
		deg[e.From]++
		deg[e.To]++
	}
	if len(b.Nodes) >= 2 && len(b.Edges) > 0 {
		for _, n := range b.Nodes {
			if deg[n.ID] == 0 {
				diags = append(diags, BoardDiag{
					Code: "ISOLATED_NODE", Severity: "info", EntityID: n.ID,
					Message:    fmt.Sprintf("Node %q is disconnected.", n.ID),
					Suggestion: "Connect with an edge or remove unused node.",
				})
			}
		}
	}
	return diags
}

// RenderSVG renders BoardData as a deterministic SVG diagram.
func (b *BoardData) RenderSVG() string {
	nodeMap := make(map[string]BoardNode, len(b.Nodes))
	maxX, maxY := 400, 260
	for _, n := range b.Nodes {
		nodeMap[n.ID] = n
		if n.X+220 > maxX {
			maxX = n.X + 220
		}
		if n.Y+120 > maxY {
			maxY = n.Y + 120
		}
	}
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" width="%d" height="%d"><rect width="%d" height="%d" fill="#ffffff"/>`, maxX, maxY, maxX, maxY, maxX, maxY))
	for _, e := range b.Edges {
		a, ok1 := nodeMap[e.From]
		c, ok2 := nodeMap[e.To]
		if !ok1 || !ok2 {
			continue
		}
		sb.WriteString(fmt.Sprintf(`<line x1="%d" y1="%d" x2="%d" y2="%d" stroke="#646a73" stroke-width="2"/>`, a.X+75, a.Y+30, c.X+75, c.Y+30))
	}
	for _, n := range b.Nodes {
		sb.WriteString(fmt.Sprintf(`<rect x="%d" y="%d" width="150" height="60" rx="8" fill="#eef3fe" stroke="#3370ff" stroke-width="2"/>`, n.X, n.Y))
		sb.WriteString(fmt.Sprintf(`<text x="%d" y="%d" font-family="sans-serif" font-size="14" fill="#1f2329" text-anchor="middle">%s</text>`, n.X+75, n.Y+35, xmlEscape(n.Text)))
	}
	sb.WriteString(`</svg>`)
	return sb.String()
}
