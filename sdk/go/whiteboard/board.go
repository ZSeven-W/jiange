package whiteboard

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"strings"
)

// Node represents a flowchart node or mind map topic on a Board.
type Node struct {
	ID    string `json:"id"`
	Text  string `json:"text"`
	Shape string `json:"shape"`
	X     int    `json:"x"`
	Y     int    `json:"y"`
}

// Edge represents a directed connection between two nodes.
type Edge struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Label string `json:"label,omitempty"`
}

// Board is the pure-Go headless whiteboard and mind map model.
type Board struct {
	Nodes []Node `json:"nodes"`
	Edges []Edge `json:"edges"`
}

// Op represents an atomic graph mutation (addNode, updateNode, deleteNode, addEdge, deleteEdge).
type Op struct {
	Op    string `json:"op"`
	ID    string `json:"id,omitempty"`
	Text  string `json:"text,omitempty"`
	Shape string `json:"shape,omitempty"`
	X     int    `json:"x,omitempty"`
	Y     int    `json:"y,omitempty"`
	From  string `json:"from,omitempty"`
	To    string `json:"to,omitempty"`
	Label string `json:"label,omitempty"`
}

// Diagnostic reports graph topology problems.
type Diagnostic struct {
	Code       string `json:"code"`
	Severity   string `json:"severity"`
	EntityID   string `json:"entityId,omitempty"`
	Message    string `json:"message"`
	Suggestion string `json:"suggestion"`
}

// ParseMermaid parses Mermaid flowchart syntax into a Board.
func ParseMermaid(code string) *Board {
	b := &Board{Nodes: make([]Node, 0), Edges: make([]Edge, 0)}
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
			b.Nodes = append(b.Nodes, Node{
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
		matchedEdge := false
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
					b.Edges = append(b.Edges, Edge{From: fromID, To: toID, Label: label})
				}
				matchedEdge = true
				break
			}
		}
		if !matchedEdge {
			ensure(line)
		}
	}
	return b
}

// ToMermaid serializes a Board as a Mermaid flowchart TD definition.
func (b *Board) ToMermaid() string {
	var sb strings.Builder
	sb.WriteString("flowchart TD\n")
	for _, n := range b.Nodes {
		open, closeTok := "[", "]"
		switch n.Shape {
		case "terminator":
			open, closeTok = "([", "])"
		case "diamond":
			open, closeTok = "{", "}"
		case "ellipse":
			open, closeTok = "((", "))"
		case "round":
			open, closeTok = "(", ")"
		}
		sb.WriteString(fmt.Sprintf("  %s%s\"%s\"%s\n", n.ID, open, strings.ReplaceAll(n.Text, `"`, `'`), closeTok))
	}
	for _, e := range b.Edges {
		if e.Label != "" {
			sb.WriteString(fmt.Sprintf("  %s -->|%s| %s\n", e.From, e.Label, e.To))
		} else {
			sb.WriteString(fmt.Sprintf("  %s --> %s\n", e.From, e.To))
		}
	}
	return sb.String()
}

// ParseXMind reads content.json from an XMind ZEN .xmind archive into a Board.
func ParseXMind(data []byte) (*Board, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("whiteboard: invalid xmind zip: %w", err)
	}
	var content []byte
	for _, f := range zr.File {
		if f.Name == "content.json" {
			rc, err := f.Open()
			if err != nil {
				return nil, err
			}
			content, err = io.ReadAll(io.LimitReader(rc, 8*1024*1024))
			_ = rc.Close()
			if err != nil {
				return nil, err
			}
			break
		}
	}
	if len(content) == 0 {
		return nil, errors.New("whiteboard: content.json not found in xmind")
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
	b := &Board{Nodes: make([]Node, 0), Edges: make([]Edge, 0)}
	var walk func(t xmTopic, parentID string, depth int)
	walk = func(t xmTopic, parentID string, depth int) {
		id := t.ID
		if id == "" {
			id = fmt.Sprintf("m%d", len(b.Nodes)+1)
		}
		b.Nodes = append(b.Nodes, Node{
			ID: id, Text: t.Title, Shape: "round",
			X: 60 + depth*220, Y: 60 + len(b.Nodes)*80,
		})
		if parentID != "" {
			b.Edges = append(b.Edges, Edge{From: parentID, To: id})
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
func (b *Board) Inspect() map[string]any {
	return map[string]any{
		"nodeCount": len(b.Nodes),
		"edgeCount": len(b.Edges),
		"nodes":     b.Nodes,
		"edges":     b.Edges,
	}
}

// Apply atomically executes board graph ops with rollback on error or dryRun.
func (b *Board) Apply(ops []Op, dryRun bool) (int, []string, error) {
	backupNodes := append([]Node(nil), b.Nodes...)
	backupEdges := append([]Edge(nil), b.Edges...)
	restore := func() {
		b.Nodes = backupNodes
		b.Edges = backupEdges
	}
	var diff []string

	for i, op := range ops {
		switch op.Op {
		case "addNode":
			id := strings.TrimSpace(op.ID)
			if id == "" {
				id = fmt.Sprintf("n%d", len(b.Nodes)+1)
			}
			for _, n := range b.Nodes {
				if n.ID == id {
					restore()
					return 0, nil, fmt.Errorf("op[%d]: node %q already exists", i, id)
				}
			}
			shape := op.Shape
			if shape == "" {
				shape = "rect"
			}
			x, y := op.X, op.Y
			if x == 0 && y == 0 {
				idx := len(b.Nodes)
				x = 60 + (idx%4)*210
				y = 60 + (idx/4)*120
			}
			b.Nodes = append(b.Nodes, Node{ID: id, Text: op.Text, Shape: shape, X: x, Y: y})
			diff = append(diff, fmt.Sprintf("added node %s", id))
		case "updateNode":
			idx := -1
			for ni, n := range b.Nodes {
				if n.ID == op.ID {
					idx = ni
					break
				}
			}
			if idx < 0 {
				restore()
				return 0, nil, fmt.Errorf("op[%d]: node %q not found", i, op.ID)
			}
			if op.Text != "" {
				b.Nodes[idx].Text = op.Text
			}
			if op.Shape != "" {
				b.Nodes[idx].Shape = op.Shape
			}
			if op.X != 0 {
				b.Nodes[idx].X = op.X
			}
			if op.Y != 0 {
				b.Nodes[idx].Y = op.Y
			}
			diff = append(diff, fmt.Sprintf("updated node %s", op.ID))
		case "deleteNode":
			idx := -1
			for ni, n := range b.Nodes {
				if n.ID == op.ID {
					idx = ni
					break
				}
			}
			if idx < 0 {
				restore()
				return 0, nil, fmt.Errorf("op[%d]: node %q not found", i, op.ID)
			}
			b.Nodes = append(b.Nodes[:idx], b.Nodes[idx+1:]...)
			kept := make([]Edge, 0, len(b.Edges))
			for _, e := range b.Edges {
				if e.From != op.ID && e.To != op.ID {
					kept = append(kept, e)
				}
			}
			b.Edges = kept
			diff = append(diff, fmt.Sprintf("deleted node %s", op.ID))
		case "addEdge":
			if strings.TrimSpace(op.From) == "" || strings.TrimSpace(op.To) == "" {
				restore()
				return 0, nil, fmt.Errorf("op[%d]: edge requires from and to", i)
			}
			b.Edges = append(b.Edges, Edge{From: op.From, To: op.To, Label: op.Label})
			diff = append(diff, fmt.Sprintf("added edge %s -> %s", op.From, op.To))
		case "deleteEdge":
			idx := -1
			for ei, e := range b.Edges {
				if e.From == op.From && e.To == op.To {
					idx = ei
					break
				}
			}
			if idx < 0 {
				restore()
				return 0, nil, fmt.Errorf("op[%d]: edge %s -> %s not found", i, op.From, op.To)
			}
			b.Edges = append(b.Edges[:idx], b.Edges[idx+1:]...)
			diff = append(diff, fmt.Sprintf("deleted edge %s -> %s", op.From, op.To))
		default:
			restore()
			return 0, nil, fmt.Errorf("op[%d]: unsupported op %q", i, op.Op)
		}
	}
	if dryRun {
		restore()
	}
	return len(diff), diff, nil
}

// Verify detects empty boards, dangling edges, and isolated nodes.
func (b *Board) Verify() []Diagnostic {
	diags := make([]Diagnostic, 0)
	if len(b.Nodes) == 0 {
		return []Diagnostic{{
			Code:       "EMPTY_BOARD",
			Severity:   "warning",
			Message:    "Board contains 0 nodes.",
			Suggestion: "Add nodes and edges.",
		}}
	}
	nodeSet := make(map[string]bool, len(b.Nodes))
	deg := make(map[string]int, len(b.Nodes))
	for _, n := range b.Nodes {
		nodeSet[n.ID] = true
	}
	for _, e := range b.Edges {
		if !nodeSet[e.From] || !nodeSet[e.To] {
			diags = append(diags, Diagnostic{
				Code:       "DANGLING_EDGE",
				Severity:   "error",
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
				diags = append(diags, Diagnostic{
					Code:       "ISOLATED_NODE",
					Severity:   "info",
					EntityID:   n.ID,
					Message:    fmt.Sprintf("Node %q is disconnected.", n.ID),
					Suggestion: "Connect with an edge or remove unused node.",
				})
			}
		}
	}
	return diags
}

func xmlEscape(s string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

// RenderSVG renders the Board as a deterministic SVG diagram.
func (b *Board) RenderSVG() string {
	nodeMap := make(map[string]Node, len(b.Nodes))
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
