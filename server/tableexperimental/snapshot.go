package tableexperimental

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"sort"
	"strconv"
	"unicode/utf8"
)

func exactFields(raw map[string]json.RawMessage, keys ...string) bool {
	if len(raw) != len(keys) {
		return false
	}
	for _, key := range keys {
		if _, ok := raw[key]; !ok {
			return false
		}
	}
	return true
}

// Reject duplicate keys before json.Unmarshal can silently keep the last
// value. This prevents runtime-dependent snapshots from discarding content.
func noDuplicateKeys(raw []byte) error {
	return scanJSON(raw, 0)
}

// scanJSON validates object keys and limits array entries before full JSON
// materialization. Zero arrayLimit disables the count for individual ops.
func scanJSON(raw []byte, arrayLimit int) error {
	type frame struct {
		object bool
		key    bool
		seen   map[string]struct{}
		count  int
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	stack := []frame{}
	for {
		tok, err := d.Token()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		if delim, ok := tok.(json.Delim); ok {
			if delim == '}' || delim == ']' {
				if len(stack) == 0 {
					return errors.New("unexpected closing delimiter")
				}
				stack = stack[:len(stack)-1]
				continue
			}
			if len(stack) > 0 {
				top := &stack[len(stack)-1]
				if top.object && !top.key {
					top.key = true
				} else if !top.object {
					top.count++
					if arrayLimit > 0 && top.count > arrayLimit {
						return limit("maxOperations")
					}
				}
			}
			switch delim {
			case '{':
				stack = append(stack, frame{object: true, key: true, seen: map[string]struct{}{}})
			case '[':
				stack = append(stack, frame{})
			default:
				return errors.New("unexpected delimiter")
			}
			if len(stack) > 128 {
				return errors.New("table snapshot nesting exceeds limit")
			}
			continue
		}
		if len(stack) == 0 {
			continue
		}
		top := &stack[len(stack)-1]
		if !top.object {
			top.count++
			if arrayLimit > 0 && top.count > arrayLimit {
				return limit("maxOperations")
			}
			continue
		}
		if top.key {
			key, ok := tok.(string)
			if !ok {
				return errors.New("invalid object key")
			}
			if _, exists := top.seen[key]; exists {
				return errors.New("duplicate object key")
			}
			top.seen[key] = struct{}{}
			top.key = false
		} else {
			top.key = true
		}
	}
}

func number(raw json.RawMessage) (int64, error) {
	if len(raw) == 0 || raw[0] == '"' || bytes.Equal(raw, []byte("null")) {
		return 0, errors.New("invalid id number")
	}
	n, err := strconv.ParseFloat(string(raw), 64)
	if err != nil || math.IsNaN(n) || math.IsInf(n, 0) || n != math.Trunc(n) || n < 1 || n > float64(maxSafeInteger) {
		return 0, errors.New("invalid id number")
	}
	return int64(n), nil
}

func (id *ID) UnmarshalJSON(data []byte) error {
	if err := noDuplicateKeys(data); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	if !exactFields(fields, "client", "clock") {
		return errors.New("invalid id fields")
	}
	client, err := number(fields["client"])
	if err != nil {
		return err
	}
	clock, err := number(fields["clock"])
	if err != nil {
		return err
	}
	*id = ID{Client: client, Clock: clock}
	return nil
}

func (op *Op) UnmarshalJSON(data []byte) error {
	if !utf8.Valid(data) || !validSurrogates(data) {
		return errors.New("invalid unicode in table operation")
	}
	if err := noDuplicateKeys(data); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	var kind string
	if err := json.Unmarshal(fields["kind"], &kind); err != nil {
		return err
	}
	var valid bool
	switch kind {
	case "axis-insert":
		valid = exactFields(fields, "kind", "id", "axis", "after")
	case "axis-delete":
		valid = exactFields(fields, "kind", "id", "axis", "target")
	case "text-insert":
		valid = exactFields(fields, "kind", "id", "row", "column", "after", "char")
	case "text-delete":
		valid = exactFields(fields, "kind", "id", "row", "column", "target")
	}
	if !valid {
		return errors.New("invalid table operation fields")
	}
	type alias Op
	var result alias
	if err := json.Unmarshal(data, &result); err != nil {
		return err
	}
	*op = Op(result)
	return nil
}

// MarshalJSON emits the same shape as the TypeScript prototype, including
// an explicit null anchor for insertions at the root.
func (op Op) MarshalJSON() ([]byte, error) {
	switch op.Kind {
	case "axis-insert":
		return json.Marshal(struct {
			Kind  string `json:"kind"`
			ID    ID     `json:"id"`
			Axis  string `json:"axis"`
			After *ID    `json:"after"`
		}{op.Kind, op.ID, op.Axis, op.After})
	case "axis-delete":
		return json.Marshal(struct {
			Kind   string `json:"kind"`
			ID     ID     `json:"id"`
			Axis   string `json:"axis"`
			Target *ID    `json:"target"`
		}{op.Kind, op.ID, op.Axis, op.Target})
	case "text-insert":
		return json.Marshal(struct {
			Kind   string `json:"kind"`
			ID     ID     `json:"id"`
			Row    *ID    `json:"row"`
			Column *ID    `json:"column"`
			After  *ID    `json:"after"`
			Char   string `json:"char"`
		}{op.Kind, op.ID, op.Row, op.Column, op.After, op.Char})
	case "text-delete":
		return json.Marshal(struct {
			Kind   string `json:"kind"`
			ID     ID     `json:"id"`
			Row    *ID    `json:"row"`
			Column *ID    `json:"column"`
			Target *ID    `json:"target"`
		}{op.Kind, op.ID, op.Row, op.Column, op.Target})
	default:
		return nil, errors.New("unknown table operation")
	}
}

// Snapshot preserves the entire ledger, including pending and rejected ops.
// It does not promise byte-identical JSON escaping across language runtimes.
func (t *Table) Snapshot() ([]byte, error) {
	ops := make([]Op, 0, len(t.entries))
	for _, e := range t.entries {
		ops = append(ops, e.op)
	}
	sort.Slice(ops, func(i, j int) bool { return cmp(ops[i].ID, ops[j].ID) < 0 })
	raw, err := json.Marshal(struct {
		Version int  `json:"version"`
		Ops     []Op `json:"ops"`
	}{1, ops})
	if err != nil {
		return nil, err
	}
	if len(raw) > t.limits.MaxSnapshotBytes {
		return nil, limit("maxSnapshotBytes")
	}
	return raw, nil
}

// FromSnapshot rejects malformed Unicode escape sequences instead of silently
// replacing unpaired UTF-16 surrogates with U+FFFD during Go JSON decoding.
func FromSnapshot(raw []byte) (*Table, error) {
	return FromSnapshotWithLimits(raw, DefaultLimits())
}

// FromSnapshotWithLimits builds a private table and returns it only after all
// admission checks pass. Sorting a snapshot can temporarily create more
// pending operations than its final state; the replay limit is bounded by the
// operation limit and the final pending count is checked before publication.
func FromSnapshotWithLimits(raw []byte, limits Limits) (*Table, error) {
	if err := limits.validate(); err != nil {
		return nil, err
	}
	if len(raw) > limits.MaxSnapshotBytes {
		return nil, limit("maxSnapshotBytes")
	}
	if !utf8.Valid(raw) || !validSurrogates(raw) {
		return nil, errors.New("invalid unicode in table snapshot")
	}
	if err := scanJSON(raw, limits.MaxOperations); err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, err
	}
	if !exactFields(fields, "version", "ops") {
		return nil, errors.New("invalid snapshot fields")
	}
	version, err := number(fields["version"])
	if err != nil || version != 1 || bytes.Equal(bytes.TrimSpace(fields["ops"]), []byte("null")) {
		return nil, errors.New("invalid experimental table snapshot")
	}
	var ops []Op
	if err := json.Unmarshal(fields["ops"], &ops); err != nil {
		return nil, err
	}
	replayLimits := limits
	if replayLimits.MaxPending < replayLimits.MaxOperations {
		replayLimits.MaxPending = replayLimits.MaxOperations
	}
	t, err := NewWithLimits(replayLimits)
	if err != nil {
		return nil, err
	}
	for _, op := range ops {
		if _, err := t.Apply(op); err != nil {
			return nil, err
		}
	}
	if t.PendingCount() > limits.MaxPending {
		return nil, limit("maxPending")
	}
	t.limits = limits
	return t, nil
}

// JSON's \u notation can encode invalid lone surrogates; the JS normalizer
// rejects them in operation strings, whereas encoding/json substitutes U+FFFD.
// Reject all lone surrogate escapes before decoding (even in ignored fields).
func validSurrogates(data []byte) bool {
	inString := false
	for i := 0; i < len(data); i++ {
		if !inString {
			if data[i] == '"' {
				inString = true
			}
			continue
		}
		if data[i] == '"' {
			inString = false
			continue
		}
		if data[i] != '\\' {
			continue
		}
		i++
		if i >= len(data) {
			return false
		}
		if data[i] != 'u' {
			continue
		}
		if i+4 >= len(data) {
			return false
		}
		n, ok := hex4(data[i+1 : i+5])
		if !ok {
			return false
		}
		i += 4
		if n >= 0xdc00 && n <= 0xdfff {
			return false
		}
		if n >= 0xd800 && n <= 0xdbff {
			if i+6 >= len(data) || data[i+1] != '\\' || data[i+2] != 'u' {
				return false
			}
			m, ok := hex4(data[i+3 : i+7])
			if !ok || m < 0xdc00 || m > 0xdfff {
				return false
			}
			i += 6
		}
	}
	return true
}

func hex4(in []byte) (uint16, bool) {
	var n uint16
	for _, c := range in {
		n <<= 4
		switch {
		case c >= '0' && c <= '9':
			n += uint16(c - '0')
		case c >= 'a' && c <= 'f':
			n += uint16(c-'a') + 10
		case c >= 'A' && c <= 'F':
			n += uint16(c-'A') + 10
		default:
			return 0, false
		}
	}
	return n, true
}
