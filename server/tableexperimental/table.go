// Package tableexperimental is a transport-independent table CRDT prototype.
// It is intentionally not connected to the document protocol, storage, or UI.
package tableexperimental

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"
)

// IDs match the existing JS operation ID domain and total ordering.
type ID struct {
	Client int64 `json:"client"`
	Clock  int64 `json:"clock"`
}

const maxSafeInteger = int64(1<<53 - 1)

type Op struct {
	Kind   string `json:"kind"`
	ID     ID     `json:"id"`
	Axis   string `json:"axis,omitempty"`
	After  *ID    `json:"after,omitempty"`
	Target *ID    `json:"target,omitempty"`
	Row    *ID    `json:"row,omitempty"`
	Column *ID    `json:"column,omitempty"`
	Char   string `json:"char,omitempty"`
}

var ErrIdentityConflict = errors.New("table operation identity conflict")

// ErrResourceLimit denotes local admission failure. It must not be used as a
// distributed conflict resolution rule: replicas can see concurrent inputs in
// different orders. A production transport needs an authoritative admission
// order and independent raw-frame limits.
var ErrResourceLimit = errors.New("table resource limit")

type Limits struct {
	MaxRows, MaxColumns, MaxGridCells, MaxCharactersPerCell        int
	MaxOperations, MaxPending, MaxOperationBytes, MaxSnapshotBytes int
}

func DefaultLimits() Limits {
	return Limits{10000, 256, 1000000, 100000, 200000, 10000, 512, 33554432}
}

func (l Limits) validate() error {
	for _, n := range []int{l.MaxRows, l.MaxColumns, l.MaxGridCells, l.MaxCharactersPerCell, l.MaxOperations, l.MaxPending, l.MaxOperationBytes, l.MaxSnapshotBytes} {
		if n <= 0 || uint64(n) > uint64(maxSafeInteger) {
			return errors.New("table limits must be positive safe integers")
		}
	}
	return nil
}

func limit(name string) error { return fmt.Errorf("%w: %s", ErrResourceLimit, name) }

type node struct {
	id      ID
	after   *ID
	deleted bool
	char    string
}

type cellKey struct{ row, column ID }
type entry struct {
	op     Op
	state  string
	reason string
	wait   *ID
}

type Table struct {
	rows                          map[ID]*node
	columns                       map[ID]*node
	cells                         map[cellKey]map[ID]*node
	entries                       map[ID]*entry
	limits                        Limits
	waiters                       map[ID]map[ID]struct{}
	parents                       map[ID]ID
	ranks                         map[ID]uint8
	pending                       int
	reservedRows, reservedColumns int
	reservedChars                 map[cellKey]int
	snapshotBudget                int
}

func New() *Table {
	t, _ := NewWithLimits(DefaultLimits())
	return t
}

func NewWithLimits(limits Limits) (*Table, error) {
	if err := limits.validate(); err != nil {
		return nil, err
	}
	if limits.MaxSnapshotBytes < 22 {
		return nil, limit("maxSnapshotBytes")
	}
	return &Table{rows: map[ID]*node{}, columns: map[ID]*node{}, cells: map[cellKey]map[ID]*node{}, entries: map[ID]*entry{}, limits: limits, waiters: map[ID]map[ID]struct{}{}, parents: map[ID]ID{}, ranks: map[ID]uint8{}, reservedChars: map[cellKey]int{}, snapshotBudget: 22}, nil
}

func validID(id ID) bool {
	return id.Client > 0 && id.Client <= maxSafeInteger && id.Clock > 0 && id.Clock <= maxSafeInteger
}

func copyID(id *ID) *ID {
	if id == nil {
		return nil
	}
	v := *id
	return &v
}

func sameID(a ID, b *ID) bool { return b != nil && a == *b }

// normalize strips irrelevant fields and copies pointer values, as the TS
// prototype does before comparing a duplicate operation's identity.
func normalize(in Op) (Op, error) {
	if !validID(in.ID) {
		return Op{}, errors.New("invalid table operation id")
	}
	op := Op{Kind: in.Kind, ID: in.ID}
	switch in.Kind {
	case "axis-insert":
		if in.Target != nil || in.Row != nil || in.Column != nil || in.Char != "" || (in.Axis != "row" && in.Axis != "column") || (in.After != nil && !validID(*in.After)) || sameID(in.ID, in.After) {
			return Op{}, errors.New("invalid axis insertion")
		}
		op.Axis, op.After = in.Axis, copyID(in.After)
	case "axis-delete":
		if in.After != nil || in.Row != nil || in.Column != nil || in.Char != "" || (in.Axis != "row" && in.Axis != "column") || in.Target == nil || !validID(*in.Target) || sameID(in.ID, in.Target) {
			return Op{}, errors.New("invalid axis deletion")
		}
		op.Axis, op.Target = in.Axis, copyID(in.Target)
	case "text-insert":
		if in.Axis != "" || in.Target != nil || in.Row == nil || in.Column == nil || !validID(*in.Row) || !validID(*in.Column) || (in.After != nil && !validID(*in.After)) || sameID(in.ID, in.Row) || sameID(in.ID, in.Column) || sameID(in.ID, in.After) || !utf8.ValidString(in.Char) || utf8.RuneCountInString(in.Char) != 1 {
			return Op{}, errors.New("invalid text insertion")
		}
		op.Row, op.Column, op.After, op.Char = copyID(in.Row), copyID(in.Column), copyID(in.After), in.Char
	case "text-delete":
		if in.Axis != "" || in.After != nil || in.Char != "" || in.Row == nil || in.Column == nil || in.Target == nil || !validID(*in.Row) || !validID(*in.Column) || !validID(*in.Target) || sameID(in.ID, in.Row) || sameID(in.ID, in.Column) || sameID(in.ID, in.Target) {
			return Op{}, errors.New("invalid text deletion")
		}
		op.Row, op.Column, op.Target = copyID(in.Row), copyID(in.Column), copyID(in.Target)
	default:
		return Op{}, errors.New("unknown table operation")
	}
	return op, nil
}

func equalPtr(a, b *ID) bool { return a == nil && b == nil || a != nil && b != nil && *a == *b }
func equalOp(a, b Op) bool {
	return a.Kind == b.Kind && a.ID == b.ID && a.Axis == b.Axis && equalPtr(a.After, b.After) && equalPtr(a.Target, b.Target) && equalPtr(a.Row, b.Row) && equalPtr(a.Column, b.Column) && a.Char == b.Char
}

func cmp(a, b ID) int {
	if a.Clock < b.Clock {
		return -1
	}
	if a.Clock > b.Clock {
		return 1
	}
	if a.Client < b.Client {
		return -1
	}
	if a.Client > b.Client {
		return 1
	}
	return 0
}

// Apply admits an operation to the ledger, including pending and rejected
// entries. It returns false only for an exact idempotent retry.
func (t *Table) Apply(input Op) (bool, error) {
	op, err := normalize(input)
	if err != nil {
		return false, err
	}
	if previous := t.entries[op.ID]; previous != nil {
		if !equalOp(previous.op, op) {
			return false, fmt.Errorf("%w: %d:%d", ErrIdentityConflict, op.ID.Client, op.ID.Clock)
		}
		return false, nil
	}
	state, missing := t.dependency(op)
	if err := t.checkAdmission(op, state == "missing"); err != nil {
		return false, err
	}
	e := &entry{op: op}
	switch state {
	case "ready":
		e.state = "applied"
	case "missing":
		e.state = "pending"
		t.pending++
	default:
		e.state, e.reason = "rejected", state
	}
	t.entries[op.ID] = e
	t.reserve(op)
	var cycles []ID
	if state == "ready" {
		t.integrate(op)
	} else if state == "missing" {
		if t.setWait(e, *missing) {
			cycles = append(cycles, op.ID)
		}
	}
	t.wake([]ID{op.ID}, cycles)
	return true, nil
}

// The decoded-operation budget is independent of JSON escaping. It is not a
// substitute for a raw transport frame limit.
func operationBudget(op Op) int {
	n := 1 // ID is mandatory.
	for _, id := range []*ID{op.After, op.Target, op.Row, op.Column} {
		if id != nil {
			n++
		}
	}
	return 128 + 64*n + len(op.Char)
}

// Conservative snapshot reservation for an operation and its separator.
func snapshotOperationBudget(op Op) int {
	n := 1
	for _, id := range []*ID{op.After, op.Target, op.Row, op.Column} {
		if id != nil {
			n++
		}
	}
	return 129 + 64*n + len(op.Char)
}

func (t *Table) checkAdmission(op Op, pending bool) error {
	if operationBudget(op) > t.limits.MaxOperationBytes {
		return limit("maxOperationBytes")
	}
	if len(t.entries) >= t.limits.MaxOperations {
		return limit("maxOperations")
	}
	if snapshotOperationBudget(op) > t.limits.MaxSnapshotBytes-t.snapshotBudget {
		return limit("maxSnapshotBytes")
	}
	rows, columns := t.reservedRows, t.reservedColumns
	if op.Kind == "axis-insert" {
		if op.Axis == "row" {
			rows++
		} else {
			columns++
		}
		if rows > t.limits.MaxRows {
			return limit("maxRows")
		}
		if columns > t.limits.MaxColumns {
			return limit("maxColumns")
		}
		if columns > 0 && rows > t.limits.MaxGridCells/columns {
			return limit("maxGridCells")
		}
	}
	if op.Kind == "text-insert" && t.reservedChars[cellKey{*op.Row, *op.Column}] >= t.limits.MaxCharactersPerCell {
		return limit("maxCharactersPerCell")
	}
	if pending && t.pending >= t.limits.MaxPending {
		return limit("maxPending")
	}
	return nil
}

func (t *Table) reserve(op Op) {
	t.snapshotBudget += snapshotOperationBudget(op)
	if op.Kind == "axis-insert" {
		if op.Axis == "row" {
			t.reservedRows++
		} else {
			t.reservedColumns++
		}
	} else if op.Kind == "text-insert" {
		t.reservedChars[cellKey{*op.Row, *op.Column}]++
	}
}

func (t *Table) axis(axis string) map[ID]*node {
	if axis == "row" {
		return t.rows
	}
	return t.columns
}

func (t *Table) wrongAxis(id ID, axis string) bool {
	e := t.entries[id]
	return e != nil && (e.state == "rejected" || e.op.Kind != "axis-insert" || e.op.Axis != axis)
}

func (t *Table) wrongChar(id ID, key cellKey) bool {
	e := t.entries[id]
	return e != nil && (e.state == "rejected" || e.op.Kind != "text-insert" || *e.op.Row != key.row || *e.op.Column != key.column)
}

func (t *Table) dependency(op Op) (string, *ID) {
	if op.Kind == "axis-insert" || op.Kind == "axis-delete" {
		dep := op.After
		if op.Kind == "axis-delete" {
			dep = op.Target
		}
		if dep == nil || t.axis(op.Axis)[*dep] != nil {
			return "ready", nil
		}
		if t.wrongAxis(*dep, op.Axis) {
			return "axis dependency has wrong type", nil
		}
		return "missing", dep
	}
	if t.rows[*op.Row] == nil {
		if t.wrongAxis(*op.Row, "row") {
			return "cell axis has wrong type", nil
		}
		return "missing", op.Row
	}
	if t.columns[*op.Column] == nil {
		if t.wrongAxis(*op.Column, "column") {
			return "cell axis has wrong type", nil
		}
		return "missing", op.Column
	}
	key := cellKey{*op.Row, *op.Column}
	dep := op.After
	if op.Kind == "text-delete" {
		dep = op.Target
	}
	if dep == nil || t.cells[key][*dep] != nil {
		return "ready", nil
	}
	if t.wrongChar(*dep, key) {
		return "character dependency belongs to another cell", nil
	}
	return "missing", dep
}

func (t *Table) integrate(op Op) {
	switch op.Kind {
	case "axis-insert":
		t.axis(op.Axis)[op.ID] = &node{id: op.ID, after: copyID(op.After)}
	case "axis-delete":
		t.axis(op.Axis)[*op.Target].deleted = true
	case "text-insert", "text-delete":
		key := cellKey{*op.Row, *op.Column}
		if t.cells[key] == nil {
			t.cells[key] = map[ID]*node{}
		}
		if op.Kind == "text-insert" {
			t.cells[key][op.ID] = &node{id: op.ID, after: copyID(op.After), char: op.Char}
		} else {
			t.cells[key][*op.Target].deleted = true
		}
	}
}

func (t *Table) clearWait(e *entry) {
	if e.wait == nil {
		return
	}
	if waiting := t.waiters[*e.wait]; waiting != nil {
		delete(waiting, e.op.ID)
		if len(waiting) == 0 {
			delete(t.waiters, *e.wait)
		}
	}
	e.wait = nil
}

func (t *Table) root(id ID) ID {
	if _, ok := t.parents[id]; !ok {
		t.parents[id] = id
	}
	parent := t.parents[id]
	if parent != id {
		parent = t.root(parent)
		t.parents[id] = parent
	}
	return parent
}

// Union is an over-approximation: removed edges are retained. A disconnected
// edge cannot close a cycle; connected edges still require an exact check.
func (t *Table) union(a, b ID) bool {
	a, b = t.root(a), t.root(b)
	if a == b {
		return true
	}
	if t.ranks[a] < t.ranks[b] {
		a, b = b, a
	}
	t.parents[b] = a
	if t.ranks[a] == t.ranks[b] {
		t.ranks[a]++
	}
	return false
}

func (t *Table) setWait(e *entry, dep ID) bool {
	t.clearWait(e)
	e.wait = copyID(&dep)
	if t.waiters[dep] == nil {
		t.waiters[dep] = map[ID]struct{}{}
	}
	t.waiters[dep][e.op.ID] = struct{}{}
	return t.union(e.op.ID, dep)
}

// Follow the current first missing dependency. Only a closed cycle of known
// pending entries is rejected; missing dependencies remain pending.
func (t *Table) rejectCycle(start ID) []ID {
	seen := map[ID]int{}
	path := []ID{}
	for id := start; ; {
		if at, ok := seen[id]; ok {
			cycle := path[at:]
			for _, member := range cycle {
				e := t.entries[member]
				t.clearWait(e)
				e.state, e.reason = "rejected", "cyclic dependency"
				t.pending--
			}
			return cycle
		}
		e := t.entries[id]
		if e == nil || e.state != "pending" || e.wait == nil {
			return nil
		}
		seen[id] = len(path)
		path = append(path, id)
		id = *e.wait
	}
}

// Wake only operations whose current missing dependency changed state. The
// queue is iterative to avoid recursion with long chains.
func (t *Table) wake(queue, cycles []ID) {
	for head := 0; head < len(queue) || len(cycles) > 0; {
		// An ID becoming known can invalidate a waiting edge due to wrong type.
		// Process those notifications before considering a possible cycle, so
		// stale edges do not make the outcome depend on delivery order.
		if head == len(queue) {
			candidate := cycles[len(cycles)-1]
			cycles = cycles[:len(cycles)-1]
			queue = append(queue, t.rejectCycle(candidate)...)
			continue
		}
		waiting := t.waiters[queue[head]]
		head++
		if len(waiting) == 0 {
			continue
		}
		ids := make([]ID, 0, len(waiting))
		for id := range waiting {
			ids = append(ids, id)
		}
		sort.Slice(ids, func(i, j int) bool { return cmp(ids[i], ids[j]) < 0 })
		for _, id := range ids {
			e := t.entries[id]
			if e == nil || e.state != "pending" || e.wait == nil || *e.wait != queue[head-1] {
				continue
			}
			t.clearWait(e)
			state, missing := t.dependency(e.op)
			if state == "missing" {
				if t.setWait(e, *missing) {
					cycles = append(cycles, id)
				}
				continue
			}
			t.pending--
			if state == "ready" {
				e.state = "applied"
				t.integrate(e.op)
			} else {
				e.state, e.reason = "rejected", state
			}
			queue = append(queue, id)
		}
	}
}

func ordered(nodes map[ID]*node) []*node {
	children := map[ID][]*node{}
	var roots []*node
	for _, n := range nodes {
		if n.after == nil {
			roots = append(roots, n)
		} else {
			children[*n.after] = append(children[*n.after], n)
		}
	}
	sortNodes := func(ns []*node) { sort.Slice(ns, func(i, j int) bool { return cmp(ns[i].id, ns[j].id) > 0 }) }
	sortNodes(roots)
	for _, siblings := range children {
		sortNodes(siblings)
	}
	stack := make([]*node, 0, len(nodes))
	for i := len(roots) - 1; i >= 0; i-- {
		stack = append(stack, roots[i])
	}
	result := make([]*node, 0, len(nodes))
	for len(stack) > 0 {
		n := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		result = append(result, n)
		siblings := children[n.id]
		for i := len(siblings) - 1; i >= 0; i-- {
			stack = append(stack, siblings[i])
		}
	}
	return result
}

func (t *Table) AxisIDs(axis string, includeDeleted bool) []ID {
	if axis != "row" && axis != "column" {
		return nil
	}
	ids := []ID{}
	for _, n := range ordered(t.axis(axis)) {
		if includeDeleted || !n.deleted {
			ids = append(ids, n.id)
		}
	}
	return ids
}

func (t *Table) CellText(row, column ID, includeDeleted bool) (string, bool) {
	r, c := t.rows[row], t.columns[column]
	if r == nil || c == nil || (!includeDeleted && (r.deleted || c.deleted)) {
		return "", false
	}
	var out strings.Builder
	for _, n := range ordered(t.cells[cellKey{row, column}]) {
		if !n.deleted {
			out.WriteString(n.char)
		}
	}
	return out.String(), true
}

func (t *Table) View() [][]string {
	rows, cols := t.AxisIDs("row", false), t.AxisIDs("column", false)
	result := make([][]string, 0, len(rows))
	for _, row := range rows {
		line := make([]string, 0, len(cols))
		for _, col := range cols {
			text, _ := t.CellText(row, col, false)
			line = append(line, text)
		}
		result = append(result, line)
	}
	return result
}

func (t *Table) PendingCount() int {
	return t.pending
}

type Rejected struct {
	ID     ID     `json:"id"`
	Reason string `json:"reason"`
}

func (t *Table) Rejected() []Rejected {
	out := []Rejected{}
	for _, e := range t.entries {
		if e.state == "rejected" {
			out = append(out, Rejected{e.op.ID, e.reason})
		}
	}
	sort.Slice(out, func(i, j int) bool { return cmp(out[i].ID, out[j].ID) < 0 })
	return out
}
