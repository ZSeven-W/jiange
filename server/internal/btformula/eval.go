package btformula

import (
	"context"
	"errors"
	"math"
	"math/big"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

// ErrUnavailable means a formula references a field outside the caller's
// authorized projection. Callers must not retry with unfiltered fields.
var ErrUnavailable = errors.New("formula dependency unavailable")

// ErrUnsupported means JavaScript can produce a value Go cannot faithfully
// represent (such as an unpaired UTF-16 surrogate). It is not a blank result.
var ErrUnsupported = errors.New("formula result cannot be represented safely")

// Value is nil, bool, string, or float64, matching FormulaValue in the web app.
type Value = any

type Options struct {
	// Now and Location must be supplied by the caller for volatile/date-local
	// functions. Their absence produces ErrUnsupported rather than guessing.
	Now      time.Time
	Location *time.Location
	MaxSteps int
	// RequestBudget can be shared by all evaluations in one request. Without
	// it each call has only its own MaxSteps limit and is not safe for bulk use.
	RequestBudget *Budget
	// Context is checked during evaluation; callers running bulk requests
	// should provide the request context as well as a shared budget.
	Context context.Context
	// FullSchema contains identities/names (never values) for every field in
	// the authorized table snapshot. It is required by EvaluateFieldID to
	// detect hidden fields that share a referenced name.
	FullSchema []SchemaField
}

type SchemaField struct {
	ID   int64
	Name string
}

// Budget bounds work across multiple formula evaluations. A caller must use a
// fresh budget for each request; it is safe to share between goroutines.
type Budget struct {
	limit int64
	used  atomic.Int64
}

func NewBudget(maxSteps int) *Budget {
	if maxSteps < 1 {
		maxSteps = 1
	}
	return &Budget{limit: int64(maxSteps)}
}

func (b *Budget) spend(n int) error {
	if b == nil {
		return nil
	}
	for {
		used := b.used.Load()
		if n < 0 || int64(n) > b.limit-used {
			return &Err{Code: "#COMPLEXITY"}
		}
		if b.used.CompareAndSwap(used, used+int64(n)) {
			return nil
		}
	}
}

// Input is an authorized field. A nil value is a visible empty cell; a field
// absent from Inputs is not considered visible and cannot be referenced.
type Input struct {
	ID      int64
	Name    string
	Formula string
	Value   Value
}

type node struct {
	kind, op    string
	value       Value
	left, right *node
	args        []*node
}

type evalParser struct {
	toks     []tok
	i, depth int
}

func (p *evalParser) next() (tok, error) {
	if p.i >= len(p.toks) {
		return tok{}, &Err{Code: "#SYNTAX"}
	}
	t := p.toks[p.i]
	p.i++
	return t, nil
}
func (p *evalParser) peek(v string) bool {
	return p.i < len(p.toks) && p.toks[p.i].kind == "op" && p.toks[p.i].val == v
}
func (p *evalParser) expr(min int) (*node, error) {
	p.depth++
	defer func() { p.depth-- }()
	if p.depth > 128 {
		return nil, &Err{Code: "#COMPLEXITY"}
	}
	left, err := p.unary()
	if err != nil {
		return nil, err
	}
	for p.i < len(p.toks) && p.toks[p.i].kind == "op" {
		op := p.toks[p.i].val
		level, ok := prec[op]
		if !ok || level < min {
			break
		}
		p.i++
		right, err := p.expr(level + 1)
		if err != nil {
			return nil, err
		}
		left = &node{kind: "bin", op: op, left: left, right: right}
	}
	return left, nil
}
func (p *evalParser) unary() (*node, error) {
	if p.peek("+") || p.peek("-") {
		op := p.toks[p.i].val
		p.i++
		value, err := p.unary()
		if err != nil {
			return nil, err
		}
		if op == "-" {
			return &node{kind: "neg", left: value}, nil
		}
		return value, nil
	}
	base, err := p.atom()
	if err != nil {
		return nil, err
	}
	if p.peek("^") {
		p.i++
		right, err := p.unary()
		if err != nil {
			return nil, err
		}
		return &node{kind: "bin", op: "^", left: base, right: right}, nil
	}
	return base, nil
}
func (p *evalParser) atom() (*node, error) {
	t, err := p.next()
	if err != nil {
		return nil, err
	}
	switch t.kind {
	case "num":
		n, err := strconv.ParseFloat(t.val, 64)
		if err != nil && !errors.Is(err, strconv.ErrRange) {
			return nil, &Err{Code: "#NUM?"}
		}
		return &node{kind: "lit", value: n}, nil
	case "str":
		return &node{kind: "lit", value: t.val}, nil
	case "ref":
		return &node{kind: "ref", op: t.val}, nil
	case "ident":
		for _, r := range t.val {
			if !(r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '.') {
				return nil, &Err{Code: "#SYNTAX"}
			}
		}
		if t.val == "TRUE" {
			return &node{kind: "lit", value: true}, nil
		}
		if t.val == "FALSE" {
			return &node{kind: "lit", value: false}, nil
		}
		if !p.peek("(") {
			return nil, &Err{Code: "#NAME?"}
		}
		p.i++
		var args []*node
		if !p.peek(")") {
			for {
				arg, err := p.expr(0)
				if err != nil {
					return nil, err
				}
				args = append(args, arg)
				if !p.peek(",") {
					break
				}
				p.i++
			}
		}
		if !p.peek(")") {
			return nil, &Err{Code: "#SYNTAX"}
		}
		p.i++
		return &node{kind: "call", op: t.val, args: args}, nil
	case "op":
		if t.val == "(" {
			v, err := p.expr(0)
			if err != nil {
				return nil, err
			}
			if !p.peek(")") {
				return nil, &Err{Code: "#SYNTAX"}
			}
			p.i++
			return v, nil
		}
	}
	return nil, &Err{Code: "#SYNTAX"}
}

func parseEval(src string) (*node, error) {
	if !utf8.ValidString(src) || utf8.RuneCountInString(src) > 2000 {
		return nil, &Err{Code: "#COMPLEXITY"}
	}
	toks, err := tokenizeEval(src)
	if err != nil {
		return nil, err
	}
	if len(toks) > 4096 {
		return nil, &Err{Code: "#COMPLEXITY"}
	}
	p := evalParser{toks: toks}
	n, err := p.expr(0)
	if err != nil {
		return nil, err
	}
	if p.i != len(toks) {
		return nil, &Err{Code: "#SYNTAX"}
	}
	return n, nil
}

// tokenizeEval follows the web parser's ASCII identifiers and JavaScript trim
// rules for references. The server's validator uses different Unicode rules;
// the evaluator must not silently resolve a different field name.
func tokenizeEval(src string) ([]tok, error) {
	var out []tok
	for i := 0; i < len(src); {
		c := src[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n':
			i++
			continue
		case c >= '0' && c <= '9' || c == '.':
			j := i + 1
			for j < len(src) && (src[j] >= '0' && src[j] <= '9' || src[j] == '.') {
				j++
			}
			out = append(out, tok{kind: "num", val: src[i:j]})
			i = j
			continue
		case c == '"':
			end := strings.IndexByte(src[i+1:], '"')
			if end < 0 {
				return nil, &Err{Code: "#SYNTAX"}
			}
			out = append(out, tok{kind: "str", val: src[i+1 : i+1+end]})
			i += end + 2
			continue
		case c == '[':
			end := strings.IndexByte(src[i+1:], ']')
			if end < 0 {
				return nil, &Err{Code: "#SYNTAX"}
			}
			out = append(out, tok{kind: "ref", val: trimJS(src[i+1 : i+1+end])})
			i += end + 2
			continue
		case c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c == '_':
			j := i + 1
			for j < len(src) && (src[j] >= 'A' && src[j] <= 'Z' || src[j] >= 'a' && src[j] <= 'z' || src[j] >= '0' && src[j] <= '9' || src[j] == '_' || src[j] == '.') {
				j++
			}
			out = append(out, tok{kind: "ident", val: strings.ToUpper(src[i:j])})
			i = j
			continue
		}
		if i+1 < len(src) {
			pair := src[i : i+2]
			if pair == "<=" || pair == ">=" || pair == "!=" || pair == "<>" {
				if pair == "<>" {
					pair = "!="
				}
				out = append(out, tok{kind: "op", val: pair})
				i += 2
				continue
			}
		}
		if strings.ContainsRune("+-*/%^&=<>(),", rune(c)) {
			out = append(out, tok{kind: "op", val: string(c)})
			i++
			continue
		}
		return nil, &Err{Code: "#SYNTAX"}
	}
	return out, nil
}

// Evaluate evaluates one expression using exclusively the supplied visible
// values. A missing name returns ErrUnavailable, including in short circuits:
// this prevents using a hidden field as an inferred blank value.
func Evaluate(src string, values map[string]Value, options Options) (Value, error) {
	if options.Context != nil {
		if err := options.Context.Err(); err != nil {
			return nil, err
		}
	}
	if len(values) > 10000 {
		return nil, &Err{Code: "#COMPLEXITY"}
	}
	// Do not allocate or sort a large map if the shared request is already
	// exhausted. The evaluator charges validation/normalization separately.
	if err := options.RequestBudget.spend(1 + len(values)); err != nil {
		return nil, err
	}
	fields := make([]Input, 0, len(values))
	names := make([]string, 0, len(values))
	for name := range values {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		fields = append(fields, Input{Name: name, Value: values[name]})
	}
	return evaluate(src, fields, options)
}

// EvaluateField resolves by name for experimental use. Callers projecting a
// specific field must use EvaluateFieldID with the complete schema instead:
// duplicate names can otherwise select a different visible field.
func EvaluateField(name string, fields []Input, options Options) (Value, error) {
	return evaluateField(name, fields, options)
}

// EvaluateFieldID evaluates a specific authorized field. FullSchema must list
// all field identities/names, including hidden ones but without hidden values.
// Any referenced name that collides with a hidden field is unavailable.
func EvaluateFieldID(id int64, fields []Input, options Options) (Value, error) {
	return evaluateFieldID(id, fields, options)
}

type evaluator struct {
	fields      []Input
	byName      map[string]int
	byID        map[int64]int
	hiddenNames map[string]bool
	parsed      map[string]*node
	parseErr    map[string]error
	state       map[int]uint8
	cache       map[int]Value
	options     Options
	steps       int
	depth       int
}

func newEvaluator(fields []Input, options Options) (*evaluator, error) {
	if len(fields) > 10000 {
		return nil, &Err{Code: "#COMPLEXITY"}
	}
	if options.MaxSteps <= 0 {
		options.MaxSteps = 20000
	}
	if options.Context != nil {
		if err := options.Context.Err(); err != nil {
			return nil, err
		}
	}
	if err := options.RequestBudget.spend(1 + len(fields)); err != nil {
		return nil, err
	}
	total := 0
	for _, f := range fields {
		if options.Context != nil {
			if err := options.Context.Err(); err != nil {
				return nil, err
			}
		}
		total += len(f.Name) + len(f.Formula)
		if total > 4<<20 {
			return nil, &Err{Code: "#COMPLEXITY"}
		}
		cost := 1 + (3*len(f.Name)+len(f.Formula))/128
		switch value := f.Value.(type) {
		case nil, bool, float64:
		case string:
			if len(value) > 1<<20 {
				return nil, &Err{Code: "#COMPLEXITY"}
			}
			total += len(value)
			cost += len(value) / 128
			if total > 4<<20 {
				return nil, &Err{Code: "#COMPLEXITY"}
			}
		default:
			return nil, ErrUnsupported
		}
		if err := options.RequestBudget.spend(cost); err != nil {
			return nil, err
		}
		if !utf8.ValidString(f.Name) || !utf8.ValidString(f.Formula) {
			return nil, &Err{Code: "#COMPLEXITY"}
		}
		if value, ok := f.Value.(string); ok && !utf8.ValidString(value) {
			return nil, &Err{Code: "#COMPLEXITY"}
		}
	}
	e := &evaluator{fields: fields, byName: map[string]int{}, byID: map[int64]int{}, hiddenNames: map[string]bool{}, parsed: map[string]*node{}, parseErr: map[string]error{}, state: map[int]uint8{}, cache: map[int]Value{}, options: options}
	for index, f := range fields {
		if options.Context != nil {
			if err := options.Context.Err(); err != nil {
				return nil, err
			}
		}
		key := jsLower(f.Name)
		if key == "" {
			return nil, &Err{Code: "#NAME?"}
		}
		// Like the frontend dependency map, the last visible field with the
		// same case-insensitive name wins. Hidden fields are never supplied.
		e.byName[key] = index
		if f.ID != 0 {
			if f.ID < 0 {
				return nil, ErrUnavailable
			}
			if _, exists := e.byID[f.ID]; exists {
				return nil, ErrUnavailable
			}
			e.byID[f.ID] = index
		}
	}
	return e, nil
}
func (e *evaluator) step() error {
	if e.options.Context != nil {
		if err := e.options.Context.Err(); err != nil {
			return err
		}
	}
	e.steps++
	if e.steps > e.options.MaxSteps {
		return &Err{Code: "#COMPLEXITY"}
	}
	return e.options.RequestBudget.spend(1)
}

// Charge the size of strings before traversing or allocating them. AST-only
// accounting severely underestimates repeated operations on long cell values.
func (e *evaluator) chargeBytes(n int) error {
	if n < 0 {
		return &Err{Code: "#COMPLEXITY"}
	}
	if e.options.Context != nil {
		if err := e.options.Context.Err(); err != nil {
			return err
		}
	}
	units := 1 + n/128
	if units > e.options.MaxSteps-e.steps {
		return &Err{Code: "#COMPLEXITY"}
	}
	e.steps += units
	return e.options.RequestBudget.spend(units)
}

func (e *evaluator) chargeValue(v Value, multiplier int) error {
	if s, ok := v.(string); ok {
		if multiplier < 1 || len(s) > (1<<20)/multiplier {
			return &Err{Code: "#COMPLEXITY"}
		}
		return e.chargeBytes(len(s) * multiplier)
	}
	return nil
}
func (e *evaluator) field(name string) (Value, error) {
	index, ok := e.byName[jsLower(name)]
	if !ok || e.hiddenNames[jsLower(name)] {
		return nil, ErrUnavailable
	}
	return e.fieldAt(index)
}
func (e *evaluator) fieldAt(index int) (Value, error) {
	if err := e.step(); err != nil {
		return nil, err
	}
	f := e.fields[index]
	if f.Formula == "" {
		return f.Value, nil
	}
	if cached, ok := e.cache[index]; ok {
		return cached, nil
	}
	if e.state[index] == 1 {
		// evalFormulas stores a cycle marker as a string value and its caller
		// can concatenate or compare it like any other formula result.
		e.cache[index] = "#循环引用"
		return e.cache[index], nil
	}
	if e.state[index] == 2 {
		return e.cache[index], nil
	}
	e.depth++
	defer func() { e.depth-- }()
	if e.depth > 128 {
		return nil, &Err{Code: "#COMPLEXITY"}
	}
	e.state[index] = 1
	v, err := e.evalExpression(f.Formula)
	if err != nil {
		var formulaErr *Err
		if errors.As(err, &formulaErr) && !strings.HasPrefix(formulaErr.Code, "#COMPLEXITY") {
			v = formulaErr.Code
		} else {
			e.state[index] = 0
			return nil, err
		}
	}
	e.state[index] = 2
	e.cache[index] = v
	return v, nil
}
func (e *evaluator) parse(src string) (*node, error) {
	if n, ok := e.parsed[src]; ok {
		return n, e.parseErr[src]
	}
	if err := e.options.RequestBudget.spend(1 + len(src)/32); err != nil {
		return nil, err
	}
	n, err := parseEval(src)
	e.parsed[src], e.parseErr[src] = n, err
	return n, err
}

// authorize walks every syntactic dependency, including unreachable branches,
// without evaluating it. Hidden values remain unavailable while a visible
// dependency error in an unchosen IF branch does not poison the result.
func (e *evaluator) authorize(src string, visited map[int]bool, depth int) error {
	if depth > 128 {
		return &Err{Code: "#COMPLEXITY"}
	}
	n, err := e.parse(src)
	if err != nil {
		return err
	}
	var refs []string
	seen := map[string]bool{}
	var collect func(*node)
	collect = func(n *node) {
		if n == nil {
			return
		}
		if n.kind == "ref" && !seen[n.op] {
			seen[n.op] = true
			refs = append(refs, n.op)
		}
		collect(n.left)
		collect(n.right)
		for _, a := range n.args {
			collect(a)
		}
	}
	collect(n)
	for _, ref := range refs {
		if err := e.step(); err != nil {
			return err
		}
		key := jsLower(ref)
		index, ok := e.byName[key]
		if !ok || e.hiddenNames[key] {
			return ErrUnavailable
		}
		field := e.fields[index]
		if field.Formula == "" || visited[index] {
			continue
		}
		visited[index] = true
		if err := e.authorize(field.Formula, visited, depth+1); err != nil {
			// An invalid visible dependency evaluates to an error string in the
			// web dependency graph; it cannot read values while parsing fails.
			var formulaErr *Err
			if errors.As(err, &formulaErr) && !strings.HasPrefix(formulaErr.Code, "#COMPLEXITY") {
				continue
			}
			return err
		}
	}
	return nil
}
func (e *evaluator) evalExpression(src string) (Value, error) {
	n, err := e.parse(src)
	if err != nil {
		return nil, err
	}
	return e.node(n)
}
func evaluate(src string, fields []Input, options Options) (Value, error) {
	e, err := newEvaluator(fields, options)
	if err != nil {
		return nil, err
	}
	if err := e.authorize(src, map[int]bool{}, 0); err != nil {
		return nil, err
	}
	v, err := e.evalExpression(src)
	return transportValue(v, err)
}
func evaluateField(name string, fields []Input, options Options) (Value, error) {
	e, err := newEvaluator(fields, options)
	if err != nil {
		return nil, err
	}
	index, ok := e.byName[jsLower(name)]
	if !ok {
		return nil, ErrUnavailable
	}
	return e.evaluateFieldIndex(index)
}

func evaluateFieldID(id int64, fields []Input, options Options) (Value, error) {
	if id <= 0 || options.FullSchema == nil || len(options.FullSchema) > 10000 {
		return nil, ErrUnavailable
	}
	if options.Context != nil {
		if err := options.Context.Err(); err != nil {
			return nil, err
		}
	}
	if err := options.RequestBudget.spend(1 + len(options.FullSchema)); err != nil {
		return nil, err
	}
	schema := make(map[int64]string, len(options.FullSchema))
	total := 0
	for _, field := range options.FullSchema {
		if options.Context != nil {
			if err := options.Context.Err(); err != nil {
				return nil, err
			}
		}
		if field.ID <= 0 || field.Name == "" {
			return nil, ErrUnavailable
		}
		total += len(field.Name)
		if total > 4<<20 {
			return nil, &Err{Code: "#COMPLEXITY"}
		}
		if err := options.RequestBudget.spend(1 + 3*len(field.Name)/128); err != nil {
			return nil, err
		}
		if !utf8.ValidString(field.Name) {
			return nil, ErrUnavailable
		}
		if _, exists := schema[field.ID]; exists {
			return nil, ErrUnavailable
		}
		schema[field.ID] = field.Name
	}
	e, err := newEvaluator(fields, options)
	if err != nil {
		return nil, err
	}
	for _, field := range fields {
		name, exists := schema[field.ID]
		if field.ID <= 0 || !exists || name != field.Name {
			return nil, ErrUnavailable
		}
	}
	index, ok := e.byID[id]
	if !ok {
		return nil, ErrUnavailable
	}
	for _, field := range options.FullSchema {
		if _, visible := e.byID[field.ID]; !visible {
			e.hiddenNames[jsLower(field.Name)] = true
		}
	}
	return e.evaluateFieldIndex(index)
}

func (e *evaluator) evaluateFieldIndex(index int) (Value, error) {
	f := e.fields[index]
	visited := map[int]bool{index: true}
	if f.Formula != "" {
		if err := e.authorize(f.Formula, visited, 0); err != nil {
			var formulaErr *Err
			if errors.As(err, &formulaErr) && !strings.HasPrefix(formulaErr.Code, "#COMPLEXITY") {
				return formulaErr.Code, nil
			}
			return nil, err
		}
	}
	// The web engine visits formula fields in the original field order. This
	// is observable for cycles, so evaluate reachable fields in that order.
	for item := range e.fields {
		if visited[item] && e.fields[item].Formula != "" {
			if _, err := e.fieldAt(item); err != nil {
				return nil, err
			}
		}
	}
	v, err := e.fieldAt(index)
	return transportValue(v, err)
}

// Non-finite JavaScript numbers cannot be represented as a JSON number.
// Never substitute null or a misleading string when a caller projects values.
func transportValue(v Value, err error) (Value, error) {
	if err != nil {
		return nil, err
	}
	if n, ok := v.(float64); ok && (math.IsNaN(n) || math.IsInf(n, 0)) {
		return nil, ErrUnsupported
	}
	return v, nil
}

var jsDecimal = regexp.MustCompile(`^[+-]?(?:(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|Infinity)$`)

func number(v Value) (float64, error) {
	switch x := v.(type) {
	case float64:
		return x, nil
	case bool:
		if x {
			return 1, nil
		}
		return 0, nil
	case string:
		s := trimJS(x)
		if s == "" {
			break
		}
		if len(s) > 2 && s[0] == '0' && strings.ContainsRune("xXbBoO", rune(s[1])) {
			base := 16
			switch s[1] {
			case 'b', 'B':
				base = 2
			case 'o', 'O':
				base = 8
			}
			if !strings.ContainsAny(s[2:], "_+-") {
				if n, ok := new(big.Int).SetString(s[2:], base); ok && n.Sign() >= 0 {
					f, _ := new(big.Float).SetInt(n).Float64()
					return f, nil
				}
			}
		}
		if jsDecimal.MatchString(s) {
			if n, err := strconv.ParseFloat(s, 64); (err == nil || errors.Is(err, strconv.ErrRange)) && !math.IsNaN(n) {
				return n, nil
			}
		}
	}
	return 0, &Err{Code: "#VALUE?"}
}
func text(v Value) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case bool:
		if x {
			return "TRUE"
		}
		return "FALSE"
	case float64:
		if math.IsInf(x, 1) {
			return "Infinity"
		}
		if math.IsInf(x, -1) {
			return "-Infinity"
		}
		if math.IsNaN(x) {
			return "NaN"
		}
		if x == 0 {
			return "0"
		}
		abs := math.Abs(x)
		if abs >= 1e21 || abs < 1e-6 {
			formatted := strconv.FormatFloat(x, 'e', -1, 64)
			parts := strings.SplitN(formatted, "e", 2)
			exponent, _ := strconv.Atoi(parts[1])
			if exponent >= 0 {
				return parts[0] + "e+" + strconv.Itoa(exponent)
			}
			return parts[0] + "e" + strconv.Itoa(exponent)
		}
		return strconv.FormatFloat(x, 'f', -1, 64)
	}
	return ""
}
func truth(v Value) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0
	}
	return false
}

func jsPow(x, y float64) (float64, error) {
	// ECMAScript keeps the historical NaN result for ±1 ** ±Infinity.
	if math.Abs(x) == 1 && math.IsInf(y, 0) {
		return math.NaN(), nil
	}
	// Math.pow's approximation is implementation-dependent. Go and V8 can
	// differ by one ULP, which changes TEXT() and exact comparisons. Until an
	// engine-compatible implementation is available, do not silently produce
	// a different value for fractional exponents.
	if !math.IsNaN(y) && !math.IsInf(y, 0) && math.Trunc(y) != y && x != 0 && x != 1 {
		return 0, ErrUnsupported
	}
	return math.Pow(x, y), nil
}

func jsRound(x float64) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) || x == 0 {
		return x
	}
	floor := math.Floor(x)
	if x-floor >= 0.5 {
		floor++
	}
	if floor == 0 && math.Signbit(x) {
		return math.Copysign(0, -1)
	}
	return floor
}
func (e *evaluator) node(n *node) (Value, error) {
	if err := e.step(); err != nil {
		return nil, err
	}
	switch n.kind {
	case "lit":
		if err := e.chargeValue(n.value, 1); err != nil {
			return nil, err
		}
		return n.value, nil
	case "ref":
		v, err := e.field(n.op)
		if err == nil {
			err = e.chargeValue(v, 1)
		}
		return v, err
	case "neg":
		v, err := e.node(n.left)
		if err != nil {
			return nil, err
		}
		x, err := number(v)
		return -x, err
	case "bin":
		l, err := e.node(n.left)
		if err != nil {
			return nil, err
		}
		r, err := e.node(n.right)
		if err != nil {
			return nil, err
		}
		if err := e.chargeValue(l, 1); err != nil {
			return nil, err
		}
		if err := e.chargeValue(r, 1); err != nil {
			return nil, err
		}
		if n.op == "&" {
			a, b := text(l), text(r)
			if len(a)+len(b) > 1<<20 {
				return nil, &Err{Code: "#COMPLEXITY"}
			}
			if err := e.chargeBytes(len(a) + len(b)); err != nil {
				return nil, err
			}
			return a + b, nil
		}
		if strings.Contains(" = != < <= > >= ", " "+n.op+" ") {
			return compare(n.op, l, r)
		}
		a, err := number(l)
		if err != nil {
			return nil, err
		}
		b, err := number(r)
		if err != nil {
			return nil, err
		}
		switch n.op {
		case "+":
			return a + b, nil
		case "-":
			return a - b, nil
		case "*":
			return a * b, nil
		case "/":
			if b == 0 {
				return nil, &Err{Code: "#DIV/0!"}
			}
			return a / b, nil
		case "%":
			if b == 0 {
				return nil, &Err{Code: "#DIV/0!"}
			}
			return math.Mod(a, b), nil
		case "^":
			return jsPow(a, b)
		}
		return nil, &Err{Code: "#SYNTAX"}
	case "call":
		if n.op == "IF" {
			if len(n.args) < 2 {
				return nil, &Err{Code: "#SYNTAX"}
			}
			cond, err := e.node(n.args[0])
			if err != nil {
				return nil, err
			}
			if truth(cond) {
				return e.node(n.args[1])
			}
			if len(n.args) > 2 {
				return e.node(n.args[2])
			}
			return nil, nil
		}
		if n.op == "IFS" {
			for i := 0; i+1 < len(n.args); i += 2 {
				cond, err := e.node(n.args[i])
				if err != nil {
					return nil, err
				}
				if truth(cond) {
					return e.node(n.args[i+1])
				}
			}
			if len(n.args)%2 == 1 {
				return e.node(n.args[len(n.args)-1])
			}
			return nil, nil
		}
		if !funks[n.op] {
			return nil, &Err{Code: "#NAME?"}
		}
		args := make([]Value, len(n.args))
		for i, arg := range n.args {
			v, err := e.node(arg)
			if err != nil {
				return nil, err
			}
			args[i] = v
		}
		for i, v := range args {
			multiplier := 1
			if i == 0 && (n.op == "UPPER" || n.op == "LOWER") {
				multiplier = 3
			}
			if i == 0 && (n.op == "LEFT" || n.op == "RIGHT" || n.op == "MID") {
				multiplier = 4
			}
			if err := e.chargeValue(v, multiplier); err != nil {
				return nil, err
			}
		}
		return e.call(n.op, args)
	}
	return nil, &Err{Code: "#SYNTAX"}
}
func compare(op string, l, r Value) (bool, error) {
	_, ls := l.(string)
	_, rs := r.(string)
	if ls || rs {
		a, b := text(l), text(r)
		// ECMAScript compares strings by UTF-16 code units, not UTF-8 bytes.
		au, bu := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
		order := 0
		for i := 0; i < len(au) && i < len(bu); i++ {
			if au[i] < bu[i] {
				order = -1
				break
			}
			if au[i] > bu[i] {
				order = 1
				break
			}
		}
		if order == 0 {
			if len(au) < len(bu) {
				order = -1
			} else if len(au) > len(bu) {
				order = 1
			}
		}
		switch op {
		case "=":
			return order == 0, nil
		case "!=":
			return order != 0, nil
		case "<":
			return order < 0, nil
		case "<=":
			return order <= 0, nil
		case ">":
			return order > 0, nil
		case ">=":
			return order >= 0, nil
		}
	}
	a, err := number(l)
	if err != nil {
		return false, err
	}
	b, err := number(r)
	if err != nil {
		return false, err
	}
	switch op {
	case "=":
		return a == b, nil
	case "!=":
		return a != b, nil
	case "<":
		return a < b, nil
	case "<=":
		return a <= b, nil
	case ">":
		return a > b, nil
	case ">=":
		return a >= b, nil
	}
	return false, &Err{Code: "#SYNTAX"}
}

// jsSlice models JavaScript string.slice's UTF-16 indices. It refuses to
// return lone surrogates, which cannot be represented faithfully in JSON UTF-8.
func jsSlice(s string, start, end int) (string, error) {
	u := utf16.Encode([]rune(s))
	n := len(u)
	norm := func(x int) int {
		if x < 0 {
			x += n
			if x < 0 {
				return 0
			}
		}
		if x > n {
			return n
		}
		return x
	}
	start, end = norm(start), norm(end)
	if end < start {
		end = start
	}
	part := u[start:end]
	for i := 0; i < len(part); i++ {
		if part[i] >= 0xd800 && part[i] <= 0xdbff {
			if i+1 >= len(part) || part[i+1] < 0xdc00 || part[i+1] > 0xdfff {
				return "", ErrUnsupported
			}
			i++
		} else if part[i] >= 0xdc00 && part[i] <= 0xdfff {
			return "", ErrUnsupported
		}
	}
	return string(utf16.Decode(part)), nil
}

func (e *evaluator) call(name string, a []Value) (Value, error) {
	if !funks[name] {
		return nil, &Err{Code: "#NAME?"}
	}
	need := func(n int) error {
		if len(a) < n {
			return &Err{Code: "#VALUE?"}
		}
		return nil
	}
	numAt := func(i int) (float64, error) {
		if err := need(i + 1); err != nil {
			return 0, err
		}
		return number(a[i])
	}
	all := func() ([]float64, error) {
		out := make([]float64, len(a))
		for i := range a {
			v, err := number(a[i])
			if err != nil {
				return nil, err
			}
			out[i] = v
		}
		return out, nil
	}
	switch name {
	case "ABS", "FLOOR", "CEILING", "INT", "SQRT":
		x, err := numAt(0)
		if err != nil {
			return nil, err
		}
		switch name {
		case "ABS":
			return math.Abs(x), nil
		case "FLOOR":
			return math.Floor(x), nil
		case "CEILING":
			return math.Ceil(x), nil
		case "INT":
			return math.Trunc(x), nil
		default:
			if x < 0 {
				return nil, &Err{Code: "#NUM?"}
			}
			return math.Sqrt(x), nil
		}
	case "ROUND":
		x, err := numAt(0)
		if err != nil {
			return nil, err
		}
		p := float64(0)
		if len(a) > 1 {
			p, err = numAt(1)
			if err != nil {
				return nil, err
			}
		}
		m, err := jsPow(10, p)
		if err != nil {
			return nil, err
		}
		return jsRound(x*m) / m, nil
	case "MOD", "POW":
		x, err := numAt(0)
		if err != nil {
			return nil, err
		}
		y, err := numAt(1)
		if err != nil {
			return nil, err
		}
		if name == "MOD" {
			if y == 0 {
				return nil, &Err{Code: "#DIV/0!"}
			}
			return math.Mod(x, y), nil
		}
		return jsPow(x, y)
	case "MIN", "MAX", "SUM", "AVERAGE":
		vals, err := all()
		if err != nil {
			return nil, err
		}
		if name == "AVERAGE" && len(vals) == 0 {
			return nil, &Err{Code: "#DIV/0!"}
		}
		out := float64(0)
		if name == "MIN" {
			out = math.Inf(1)
		}
		if name == "MAX" {
			out = math.Inf(-1)
		}
		for _, v := range vals {
			switch name {
			case "MIN":
				out = math.Min(out, v)
			case "MAX":
				out = math.Max(out, v)
			default:
				out += v
			}
		}
		if name == "AVERAGE" {
			out /= float64(len(vals))
		}
		return out, nil
	case "AND":
		for _, v := range a {
			if !truth(v) {
				return false, nil
			}
		}
		return true, nil
	case "OR":
		for _, v := range a {
			if truth(v) {
				return true, nil
			}
		}
		return false, nil
	case "NOT":
		if len(a) == 0 {
			return true, nil
		}
		return !truth(a[0]), nil
	case "ISBLANK":
		if len(a) == 0 {
			return false, nil
		}
		return a[0] == nil || a[0] == "", nil
	case "LEN":
		if len(a) == 0 {
			return nil, &Err{Code: "#错误"}
		}
		return float64(utf8.RuneCountInString(text(a[0]))), nil
	case "UPPER", "LOWER":
		if len(a) == 0 {
			return nil, &Err{Code: "#错误"}
		}
		if name == "UPPER" {
			return cases.Upper(language.Und).String(text(a[0])), nil
		}
		return cases.Lower(language.Und).String(text(a[0])), nil
	case "CONCATENATE":
		var out strings.Builder
		for _, v := range a {
			s := text(v)
			if len(s) > (1<<20)-out.Len() {
				return nil, &Err{Code: "#COMPLEXITY"}
			}
			if err := e.chargeBytes(len(s)); err != nil {
				return nil, err
			}
			out.WriteString(s)
		}
		return out.String(), nil
	case "LEFT", "RIGHT", "MID":
		if len(a) == 0 {
			return nil, &Err{Code: "#错误"}
		}
		if err := need(2); err != nil {
			return nil, err
		}
		s := text(a[0])
		n, err := numAt(1)
		if err != nil {
			return nil, err
		}
		if math.IsNaN(n) || math.IsInf(n, 0) || math.Abs(n) > 1e9 {
			return nil, ErrUnsupported
		}
		count := int(math.Trunc(n))
		if name == "RIGHT" {
			r := []rune(s)
			if count >= len(r) {
				return s, nil
			}
			start := int(math.Trunc(float64(len(r)) - n))
			if start < 0 {
				start = 0
			}
			if start > len(r) {
				start = len(r)
			}
			return string(r[start:]), nil
		}
		if name == "LEFT" {
			return jsSlice(s, 0, count)
		}
		m, err := numAt(2)
		if err != nil {
			return nil, err
		}
		if math.IsNaN(m) || math.IsInf(m, 0) || math.Abs(m) > 1e9 {
			return nil, ErrUnsupported
		}
		return jsSlice(s, int(math.Trunc(n-1)), int(math.Trunc(n-1+m)))
	case "TRIM":
		if len(a) == 0 {
			return nil, &Err{Code: "#错误"}
		}
		return trimJS(text(a[0])), nil
	case "CONTAINS":
		if len(a) == 0 {
			return nil, &Err{Code: "#错误"}
		}
		if len(a) == 1 {
			return strings.Contains(text(a[0]), "undefined"), nil
		}
		return strings.Contains(text(a[0]), text(a[1])), nil
	case "BLANK":
		return nil, nil
	case "VALUE":
		if len(a) == 0 {
			return float64(0), nil
		}
		s := text(a[0])
		if s == "" {
			s = "0"
		}
		return number(s)
	case "TEXT":
		if len(a) == 0 {
			return nil, ErrUnsupported
		}
		return text(a[0]), nil
	case "TODAY", "NOW":
		if e.options.Now.IsZero() {
			return nil, ErrUnsupported
		}
		now := e.options.Now.UTC()
		if name == "TODAY" {
			return now.Format("2006-01-02"), nil
		}
		return now.Format("2006-01-02T15:04:05.000Z"), nil
	case "YEAR", "MONTH", "DAY":
		if err := need(1); err != nil {
			return nil, err
		}
		if e.options.Location == nil {
			return nil, ErrUnsupported
		}
		d, err := ecmaDate(text(a[0]), e.options.Location)
		if err != nil {
			return nil, ErrUnsupported
		}
		d = d.In(e.options.Location)
		switch name {
		case "YEAR":
			return float64(d.Year()), nil
		case "MONTH":
			return float64(d.Month()), nil
		default:
			return float64(d.Day()), nil
		}
	}
	return nil, &Err{Code: "#NAME?"}
}
