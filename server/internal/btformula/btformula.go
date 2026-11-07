// Package btformula validates bitable formulas server-side. It accepts the
// same grammar as the TS evaluator (apps/web/src/pages/base/formula.ts):
// numbers, "strings", [字段] refs, operators + - * / % ^ & = != < <= > >=,
// parens, TRUE/FALSE and the ~30 FUNCS names. Values are not evaluated
// server-side; formulas run client-side with a dependency graph.
package btformula

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

type Err struct{ Code string }

func (e *Err) Error() string { return e.Code }

func errf(code, detail string) error { return &Err{Code: code + ": " + detail} }

// Validate parses src and reports a syntax error (nil = valid). Ref names are
// checked against known field names when names is non-empty.
func Validate(src string, names []string) error {
	toks, err := tokenize(src)
	if err != nil {
		return err
	}
	p := &parser{toks: toks}
	refs, err := p.expr(0)
	if err != nil {
		return err
	}
	if p.i != len(toks) {
		return errf("#SYNTAX", fmt.Sprintf("unexpected token %d", p.i))
	}
	if len(names) == 0 {
		return nil
	}
	known := map[string]bool{}
	for _, n := range names {
		known[jsLower(n)] = true
	}
	for _, r := range refs {
		if !known[jsLower(r)] {
			return errf("#NAME?", "未知字段 "+r)
		}
	}
	return nil
}

// Refs returns the distinct field names referenced by the formula, in
// first-appearance order (mirrors the TS formulaRefs).
func Refs(src string) ([]string, error) {
	toks, err := tokenize(src)
	if err != nil {
		return nil, err
	}
	p := &parser{toks: toks}
	if _, err := p.expr(0); err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	out := p.refs[:0]
	for _, r := range p.refs {
		if !seen[r] {
			seen[r] = true
			out = append(out, r)
		}
	}
	return out, nil
}

var funks = map[string]bool{
	"ABS": true, "ROUND": true, "FLOOR": true, "CEILING": true, "MOD": true, "POW": true,
	"SQRT": true, "INT": true, "MIN": true, "MAX": true, "SUM": true, "AVERAGE": true,
	"IF": true, "IFS": true, "AND": true, "OR": true, "NOT": true, "ISBLANK": true,
	"LEN": true, "UPPER": true, "LOWER": true, "CONCATENATE": true, "LEFT": true,
	"RIGHT": true, "MID": true, "TRIM": true, "CONTAINS": true, "BLANK": true,
	"VALUE": true, "TEXT": true, "TODAY": true, "NOW": true, "YEAR": true, "MONTH": true, "DAY": true,
}

type tok struct {
	kind string // num | str | ref | ident | op
	val  string
}

func tokenize(src string) ([]tok, error) {
	var toks []tok
	for i := 0; i < len(src); {
		r, size := utf8.DecodeRuneInString(src[i:])
		switch {
		case r == ' ' || r == '\t' || r == '\n':
			i += size
			continue
		case r >= '0' && r <= '9' || r == '.':
			j := i
			for j < len(src) && (src[j] >= '0' && src[j] <= '9' || src[j] == '.') {
				j++
			}
			// The frontend tokenizes the whole run and applies Number(...).
			// Reject malformed runs such as "." and "1..2" instead of
			// persisting an expression the editor cannot parse. A syntactically
			// valid literal can overflow to Infinity in JavaScript, so range
			// overflow alone is not a syntax error here.
			if _, err := strconv.ParseFloat(src[i:j], 64); err != nil && !errors.Is(err, strconv.ErrRange) {
				return nil, errf("#NUM?", "无效的数字")
			}
			toks = append(toks, tok{"num", src[i:j]})
			i = j
			continue
		case r == '"':
			j := i + 1
			for j < len(src) && src[j] != '"' {
				j++
			}
			if j >= len(src) {
				return nil, errf("#SYNTAX", "未闭合的字符串")
			}
			toks = append(toks, tok{"str", src[i+1 : j]})
			i = j + 1
			continue
		case r == '[':
			end := strings.IndexByte(src[i:], ']')
			if end < 0 {
				return nil, errf("#SYNTAX", "未闭合的引用")
			}
			toks = append(toks, tok{"ref", trimJS(src[i+1 : i+end])})
			i += end + 1
			continue
		case unicode.IsLetter(r) || r == '_':
			j := i
			for j < len(src) {
				rr, sz := utf8.DecodeRuneInString(src[j:])
				if unicode.IsLetter(rr) || rr >= '0' && rr <= '9' || rr == '_' || rr == '.' {
					j += sz
				} else {
					break
				}
			}
			toks = append(toks, tok{"ident", strings.ToUpper(src[i:j])})
			i = j
			continue
		}
		if i+1 < len(src) {
			two := src[i : i+2]
			if two == "<=" || two == ">=" || two == "!=" || two == "<>" {
				if two == "<>" {
					two = "!="
				}
				toks = append(toks, tok{"op", two})
				i += 2
				continue
			}
		}
		if strings.ContainsRune("+-*/%^&=<>(),", r) {
			toks = append(toks, tok{"op", string(r)})
			i += size
			continue
		}
		return nil, errf("#SYNTAX", fmt.Sprintf("无法识别的字符 %q", string(r)))
	}
	return toks, nil
}

var prec = map[string]int{"&": 1, "=": 2, "!=": 2, "<": 2, "<=": 2, ">": 2, ">=": 2, "+": 3, "-": 3, "*": 4, "/": 4, "%": 4}

type parser struct {
	toks []tok
	i    int
	refs []string
}

func (p *parser) peek() (tok, bool) {
	if p.i < len(p.toks) {
		return p.toks[p.i], true
	}
	return tok{}, false
}

func (p *parser) next() (tok, error) {
	if p.i >= len(p.toks) {
		return tok{}, errf("#SYNTAX", "表达式提前结束")
	}
	t := p.toks[p.i]
	p.i++
	return t, nil
}

func (p *parser) expr(min int) ([]string, error) {
	if err := p.unary(); err != nil {
		return nil, err
	}
	for {
		t, ok := p.peek()
		if !ok || t.kind != "op" {
			break
		}
		level, ok := prec[t.val]
		if !ok || level < min {
			break
		}
		if _, err := p.next(); err != nil {
			return nil, err
		}
		if _, err := p.expr(level + 1); err != nil {
			return nil, err
		}
	}
	return p.refs, nil
}

func (p *parser) unary() error {
	t, ok := p.peek()
	if ok && t.kind == "op" && (t.val == "-" || t.val == "+") {
		if _, err := p.next(); err != nil {
			return err
		}
		return p.unary()
	}
	return p.pow()
}

func (p *parser) pow() error {
	if err := p.atom(); err != nil {
		return err
	}
	t, ok := p.peek()
	if ok && t.kind == "op" && t.val == "^" {
		if _, err := p.next(); err != nil {
			return err
		}
		return p.unary()
	}
	return nil
}

func (p *parser) atom() error {
	t, err := p.next()
	if err != nil {
		return err
	}
	switch t.kind {
	case "num", "str":
		return nil
	case "ref":
		p.refs = append(p.refs, t.val)
		return nil
	case "ident":
		if t.val == "TRUE" || t.val == "FALSE" {
			return nil
		}
		if n, ok := p.peek(); ok && n.kind == "op" && n.val == "(" {
			if !funks[t.val] {
				return errf("#NAME?", "未知函数 "+t.val)
			}
			_, _ = p.next()
			if n, ok := p.peek(); ok && n.kind == "op" && n.val == ")" {
				_, _ = p.next()
				return nil
			}
			if _, err := p.expr(0); err != nil {
				return err
			}
			for {
				n, ok := p.peek()
				if !ok || n.kind != "op" || n.val != "," {
					break
				}
				_, _ = p.next()
				if _, err := p.expr(0); err != nil {
					return err
				}
			}
			end, err := p.next()
			if err != nil {
				return err
			}
			if end.kind != "op" || end.val != ")" {
				return errf("#SYNTAX", "缺少右括号")
			}
			return nil
		}
		return errf("#NAME?", "裸标识符 "+t.val)
	case "op":
		if t.val == "(" {
			if _, err := p.expr(0); err != nil {
				return err
			}
			end, err := p.next()
			if err != nil {
				return err
			}
			if end.kind != "op" || end.val != ")" {
				return errf("#SYNTAX", "缺少右括号")
			}
			return nil
		}
	}
	return errf("#SYNTAX", "意外的记号 "+t.val)
}
