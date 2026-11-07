// Package canvasmodel defines an isolated, in-memory data model for editable
// mind maps, flowcharts, and slide decks. It is not connected to the document
// protocol or any HTTP route. A caller must authorize and persist changes.
package canvasmodel

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"
)

type Kind string

const (
	MindMap   Kind = "mindmap"
	Flowchart Kind = "flowchart"
	Slides    Kind = "slides"
)

var (
	ErrInvalid  = errors.New("canvas: invalid input")
	ErrConflict = errors.New("canvas: revision conflict")
	ErrNotFound = errors.New("canvas: object not found")
	ErrInUse    = errors.New("canvas: object has live references")
	ErrLimit    = errors.New("canvas: resource limit")
)

const (
	maxObjects = 10000 // Includes tombstones, so deleted IDs cannot be reused.
	maxBatch   = 256
	maxText    = 64 << 10          // UTF-8 bytes per object, not a count of characters.
	maxVersion = uint64(1<<53 - 1) // Safe for JavaScript clients.
)

var idPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
var orderPattern = regexp.MustCompile(`^[A-Za-z0-9]{1,64}$`)
var colorPattern = regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`)

// Rect is deliberately bounded, preventing non-finite or unreasonable
// coordinates from reaching renderers. Mind-map layout may ignore X and Y.
type Rect struct {
	X, Y, Width, Height float64
}

// Node is a mind-map topic (Parent links the tree) or a flowchart shape.
// IDs and versions are server-controlled; tombstones retain deleted IDs.
type Node struct {
	ID, Parent, Order, Shape, Text, Fill string
	Rect                                 Rect
	Collapsed                            bool
	Version                              uint64
	Deleted                              bool
}

// Edge is a flowchart connector between two live nodes. Endpoints are stable
// node IDs, not positional array indexes.
type Edge struct {
	ID, From, To, Label, Stroke string
	Version                     uint64
	Deleted                     bool
}

type Page struct {
	ID, Order, Title, Background string
	Version                      uint64
	Deleted                      bool
}

// Element belongs to exactly one slide page. Asset is a server-owned asset ID,
// never an arbitrary URL; this model does not grant access to the asset.
type Element struct {
	ID, PageID, Order, Type, Text, Asset, Fill string
	Rect                                       Rect
	Version                                    uint64
	Deleted                                    bool
}

// Snapshot is detached from the live document. Tombstones are retained so a
// later operation cannot silently reuse an identity.
type Snapshot struct {
	Kind     Kind
	RootID   string
	Revision uint64
	Nodes    []Node
	Edges    []Edge
	Pages    []Page
	Elements []Element
}

type state struct {
	kind Kind
	root string
	rev  uint64
	n    map[string]Node
	e    map[string]Edge
	p    map[string]Page
	l    map[string]Element
}

type Document struct {
	mu sync.RWMutex
	s  state
}

// New creates the required root topic or first slide. Flowcharts start empty
// and therefore require an empty initialID. Supplying a root avoids silently
// generating identities that cannot be coordinated with replicas.
func New(kind Kind, initialID string) (*Document, error) {
	s := state{kind: kind, n: map[string]Node{}, e: map[string]Edge{}, p: map[string]Page{}, l: map[string]Element{}}
	switch kind {
	case MindMap:
		if !validID(initialID) {
			return nil, ErrInvalid
		}
		s.root = initialID
		s.n[initialID] = Node{ID: initialID, Order: "V", Shape: "topic", Rect: Rect{Width: 180, Height: 48}, Version: 1}
	case Slides:
		if !validID(initialID) {
			return nil, ErrInvalid
		}
		s.p[initialID] = Page{ID: initialID, Order: "V", Version: 1}
	case Flowchart:
		if initialID != "" {
			return nil, ErrInvalid
		}
	default:
		return nil, ErrInvalid
	}
	return &Document{s: s}, nil
}

// Change is a typed union. Exactly one member must be present. New objects
// have Version=0 and Deleted=false; updates replace only the specified object
// and require its current version. A batch is committed all-or-nothing.
type Change struct {
	CreateNode    *Node
	UpdateNode    *NodeUpdate
	DeleteNode    *Delete
	CreateEdge    *Edge
	UpdateEdge    *EdgeUpdate
	DeleteEdge    *Delete
	CreatePage    *Page
	UpdatePage    *PageUpdate
	DeletePage    *Delete
	CreateElement *Element
	UpdateElement *ElementUpdate
	DeleteElement *Delete
}

type Delete struct {
	ID       string
	Expected uint64
}
type NodeUpdate struct {
	Value    Node
	Expected uint64
}
type EdgeUpdate struct {
	Value    Edge
	Expected uint64
}
type PageUpdate struct {
	Value    Page
	Expected uint64
}
type ElementUpdate struct {
	Value    Element
	Expected uint64
}

// Apply checks every precondition under one lock. Per-object versions allow
// concurrent edits to different objects; structural invariants are checked
// against the latest state. On any error no part of the batch is published.
func (d *Document) Apply(changes []Change) (uint64, error) {
	if len(changes) == 0 || len(changes) > maxBatch {
		return 0, ErrLimit
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.s.rev >= maxVersion {
		return d.s.rev, ErrLimit
	}
	next := d.s.clone()
	for i, c := range changes {
		if err := next.apply(c); err != nil {
			return d.s.rev, fmt.Errorf("change %d: %w", i, err)
		}
	}
	next.rev++
	d.s = next
	return next.rev, nil
}

func (s state) clone() state {
	n := state{kind: s.kind, root: s.root, rev: s.rev, n: make(map[string]Node, len(s.n)), e: make(map[string]Edge, len(s.e)), p: make(map[string]Page, len(s.p)), l: make(map[string]Element, len(s.l))}
	for k, v := range s.n {
		n.n[k] = v
	}
	for k, v := range s.e {
		n.e[k] = v
	}
	for k, v := range s.p {
		n.p[k] = v
	}
	for k, v := range s.l {
		n.l[k] = v
	}
	return n
}

func (s *state) apply(c Change) error {
	count := 0
	for _, present := range []bool{c.CreateNode != nil, c.UpdateNode != nil, c.DeleteNode != nil, c.CreateEdge != nil, c.UpdateEdge != nil, c.DeleteEdge != nil, c.CreatePage != nil, c.UpdatePage != nil, c.DeletePage != nil, c.CreateElement != nil, c.UpdateElement != nil, c.DeleteElement != nil} {
		if present {
			count++
		}
	}
	if count != 1 {
		return ErrInvalid
	}
	switch {
	case c.CreateNode != nil:
		v := *c.CreateNode
		if s.kind != MindMap && s.kind != Flowchart || v.Version != 0 || v.Deleted || !s.validNode(v) {
			return ErrInvalid
		}
		if err := s.canCreate(v.ID); err != nil {
			return err
		}
		if s.kind == MindMap && !s.liveNode(v.Parent) {
			return ErrNotFound
		}
		v.Version = 1
		s.n[v.ID] = v
		return nil
	case c.UpdateNode != nil:
		v, expected := c.UpdateNode.Value, c.UpdateNode.Expected
		old, ok := s.n[v.ID]
		if !ok || old.Deleted {
			return ErrNotFound
		}
		if old.Version != expected {
			return ErrConflict
		}
		if old.Version >= maxVersion {
			return ErrLimit
		}
		if v.Version != 0 || v.Deleted || !s.validNode(v) {
			return ErrInvalid
		}
		if s.kind == MindMap {
			if v.ID == s.root && v.Parent != "" {
				return ErrInvalid
			}
			if v.ID != s.root && !s.liveNode(v.Parent) {
				return ErrNotFound
			}
			if s.nodeCycle(v.ID, v.Parent) {
				return ErrConflict
			}
		}
		v.Version = old.Version + 1
		s.n[v.ID] = v
		return nil
	case c.DeleteNode != nil:
		x := *c.DeleteNode
		v, ok := s.n[x.ID]
		if !ok || v.Deleted {
			return ErrNotFound
		}
		if v.Version != x.Expected {
			return ErrConflict
		}
		if v.Version >= maxVersion {
			return ErrLimit
		}
		if x.ID == s.root {
			return ErrInvalid
		}
		for _, child := range s.n {
			if !child.Deleted && child.Parent == x.ID {
				return ErrInUse
			}
		}
		for _, edge := range s.e {
			if !edge.Deleted && (edge.From == x.ID || edge.To == x.ID) {
				return ErrInUse
			}
		}
		v.Deleted = true
		v.Version++
		s.n[x.ID] = v
		return nil
	case c.CreateEdge != nil:
		v := *c.CreateEdge
		if s.kind != Flowchart || v.Version != 0 || v.Deleted || !validEdge(v) {
			return ErrInvalid
		}
		if err := s.canCreate(v.ID); err != nil {
			return err
		}
		if !s.liveNode(v.From) || !s.liveNode(v.To) {
			return ErrNotFound
		}
		v.Version = 1
		s.e[v.ID] = v
		return nil
	case c.UpdateEdge != nil:
		v, x := c.UpdateEdge.Value, c.UpdateEdge.Expected
		old, ok := s.e[v.ID]
		if !ok || old.Deleted {
			return ErrNotFound
		}
		if old.Version != x {
			return ErrConflict
		}
		if old.Version >= maxVersion {
			return ErrLimit
		}
		if v.Version != 0 || v.Deleted || !validEdge(v) {
			return ErrInvalid
		}
		if !s.liveNode(v.From) || !s.liveNode(v.To) {
			return ErrNotFound
		}
		v.Version = old.Version + 1
		s.e[v.ID] = v
		return nil
	case c.DeleteEdge != nil:
		x := *c.DeleteEdge
		v, ok := s.e[x.ID]
		if !ok || v.Deleted {
			return ErrNotFound
		}
		if v.Version != x.Expected {
			return ErrConflict
		}
		if v.Version >= maxVersion {
			return ErrLimit
		}
		v.Deleted = true
		v.Version++
		s.e[x.ID] = v
		return nil
	case c.CreatePage != nil:
		v := *c.CreatePage
		if s.kind != Slides || v.Version != 0 || v.Deleted || !validPage(v) {
			return ErrInvalid
		}
		if err := s.canCreate(v.ID); err != nil {
			return err
		}
		v.Version = 1
		s.p[v.ID] = v
		return nil
	case c.UpdatePage != nil:
		v, x := c.UpdatePage.Value, c.UpdatePage.Expected
		old, ok := s.p[v.ID]
		if !ok || old.Deleted {
			return ErrNotFound
		}
		if old.Version != x {
			return ErrConflict
		}
		if old.Version >= maxVersion {
			return ErrLimit
		}
		if v.Version != 0 || v.Deleted || !validPage(v) {
			return ErrInvalid
		}
		v.Version = old.Version + 1
		s.p[v.ID] = v
		return nil
	case c.DeletePage != nil:
		x := *c.DeletePage
		v, ok := s.p[x.ID]
		if !ok || v.Deleted {
			return ErrNotFound
		}
		if v.Version != x.Expected {
			return ErrConflict
		}
		if v.Version >= maxVersion {
			return ErrLimit
		}
		for _, e := range s.l {
			if !e.Deleted && e.PageID == x.ID {
				return ErrInUse
			}
		}
		v.Deleted = true
		v.Version++
		s.p[x.ID] = v
		return nil
	case c.CreateElement != nil:
		v := *c.CreateElement
		if s.kind != Slides || v.Version != 0 || v.Deleted || !validElement(v) {
			return ErrInvalid
		}
		if err := s.canCreate(v.ID); err != nil {
			return err
		}
		if !s.livePage(v.PageID) {
			return ErrNotFound
		}
		v.Version = 1
		s.l[v.ID] = v
		return nil
	case c.UpdateElement != nil:
		v, x := c.UpdateElement.Value, c.UpdateElement.Expected
		old, ok := s.l[v.ID]
		if !ok || old.Deleted {
			return ErrNotFound
		}
		if old.Version != x {
			return ErrConflict
		}
		if old.Version >= maxVersion {
			return ErrLimit
		}
		if v.Version != 0 || v.Deleted || !validElement(v) {
			return ErrInvalid
		}
		if !s.livePage(v.PageID) {
			return ErrNotFound
		}
		v.Version = old.Version + 1
		s.l[v.ID] = v
		return nil
	case c.DeleteElement != nil:
		x := *c.DeleteElement
		v, ok := s.l[x.ID]
		if !ok || v.Deleted {
			return ErrNotFound
		}
		if v.Version != x.Expected {
			return ErrConflict
		}
		if v.Version >= maxVersion {
			return ErrLimit
		}
		v.Deleted = true
		v.Version++
		s.l[x.ID] = v
		return nil
	}
	return ErrInvalid
}

func (s *state) canCreate(id string) error {
	if !validID(id) {
		return ErrInvalid
	}
	if len(s.n)+len(s.e)+len(s.p)+len(s.l) >= maxObjects {
		return ErrLimit
	}
	if _, ok := s.n[id]; ok {
		return ErrConflict
	}
	if _, ok := s.e[id]; ok {
		return ErrConflict
	}
	if _, ok := s.p[id]; ok {
		return ErrConflict
	}
	if _, ok := s.l[id]; ok {
		return ErrConflict
	}
	return nil
}
func (s *state) liveNode(id string) bool { v, ok := s.n[id]; return ok && !v.Deleted }
func (s *state) livePage(id string) bool { v, ok := s.p[id]; return ok && !v.Deleted }
func (s *state) nodeCycle(id, parent string) bool {
	for steps := 0; parent != ""; steps++ {
		if parent == id || steps > len(s.n) {
			return true
		}
		v, ok := s.n[parent]
		if !ok || v.Deleted {
			return true
		}
		parent = v.Parent
	}
	return false
}
func validID(v string) bool { return idPattern.MatchString(v) }
func validText(v string) bool {
	if len(v) > maxText || !utf8.ValidString(v) {
		return false
	}
	for _, r := range v {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return false
		}
	}
	return true
}
func validColor(v string) bool { return v == "" || colorPattern.MatchString(v) }
func validRect(r Rect) bool {
	return !math.IsNaN(r.X) && !math.IsNaN(r.Y) && !math.IsNaN(r.Width) && !math.IsNaN(r.Height) && !math.IsInf(r.X, 0) && !math.IsInf(r.Y, 0) && !math.IsInf(r.Width, 0) && !math.IsInf(r.Height, 0) && math.Abs(r.X) <= 1e6 && math.Abs(r.Y) <= 1e6 && r.Width >= 1 && r.Width <= 1e5 && r.Height >= 1 && r.Height <= 1e5
}
func (s *state) validNode(v Node) bool {
	if !validID(v.ID) || !orderPattern.MatchString(v.Order) || !validText(v.Text) || !validColor(v.Fill) || !validRect(v.Rect) {
		return false
	}
	if s.kind == MindMap {
		return v.Shape == "topic" && (v.Parent == "" || validID(v.Parent))
	}
	return s.kind == Flowchart && v.Parent == "" && !v.Collapsed && (v.Shape == "rectangle" || v.Shape == "ellipse" || v.Shape == "diamond" || v.Shape == "text")
}
func validEdge(v Edge) bool {
	return validID(v.ID) && validID(v.From) && validID(v.To) && validText(v.Label) && validColor(v.Stroke)
}
func validPage(v Page) bool {
	return validID(v.ID) && orderPattern.MatchString(v.Order) && validText(v.Title) && validColor(v.Background)
}
func validElement(v Element) bool {
	if !validID(v.ID) || !validID(v.PageID) || !orderPattern.MatchString(v.Order) || !validText(v.Text) || !validColor(v.Fill) || !validRect(v.Rect) {
		return false
	}
	switch v.Type {
	case "text", "rectangle", "ellipse":
		return v.Asset == ""
	case "image":
		return validID(v.Asset) && v.Text == ""
	default:
		return false
	}
}

// Snapshot returns values ordered deterministically. Mutating the returned
// slices never changes the document.
func (d *Document) Snapshot() Snapshot {
	d.mu.RLock()
	defer d.mu.RUnlock()
	r := Snapshot{Kind: d.s.kind, RootID: d.s.root, Revision: d.s.rev}
	for _, v := range d.s.n {
		r.Nodes = append(r.Nodes, v)
	}
	for _, v := range d.s.e {
		r.Edges = append(r.Edges, v)
	}
	for _, v := range d.s.p {
		r.Pages = append(r.Pages, v)
	}
	for _, v := range d.s.l {
		r.Elements = append(r.Elements, v)
	}
	sort.Slice(r.Nodes, func(i, j int) bool { return strings.Compare(r.Nodes[i].ID, r.Nodes[j].ID) < 0 })
	sort.Slice(r.Edges, func(i, j int) bool { return r.Edges[i].ID < r.Edges[j].ID })
	sort.Slice(r.Pages, func(i, j int) bool { return r.Pages[i].ID < r.Pages[j].ID })
	sort.Slice(r.Elements, func(i, j int) bool { return r.Elements[i].ID < r.Elements[j].ID })
	return r
}
