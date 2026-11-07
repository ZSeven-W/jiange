package btformula

import (
	"strings"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

// Formula field references use JavaScript's locale-independent lowercase,
// as does the browser's formula dependency map. In particular, U+0130 maps
// to an i plus a combining dot rather than the single rune Go's ToLower uses.
func jsLower(s string) string { return cases.Lower(language.Und).String(s) }

// ECMAScript String.trim uses WhiteSpace and LineTerminator, not Go's
// Unicode White_Space (notably U+FEFF is included and U+0085 is not).
func trimJS(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		return r >= '\u0009' && r <= '\u000d' || r == '\u0020' || r == '\u00a0' || r == '\u1680' ||
			r >= '\u2000' && r <= '\u200a' || r == '\u2028' || r == '\u2029' ||
			r == '\u202f' || r == '\u205f' || r == '\u3000' || r == '\ufeff'
	})
}
