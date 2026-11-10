package btquery

import (
	"encoding/json"
	"strings"
	"testing"
)

// Person cells may hold a scalar id (single mode / legacy) or an array of ids
// (允许多选). Filters must treat a scalar as a one-member set, and must never
// substring-match ids inside the JSON text ("1" inside "[11, 2]").
var personFields = []FieldSpec{
	{ID: 5, Type: "person"},
	{ID: 6, Type: "person"},
}

var personRecs = []map[string]json.RawMessage{
	{"5": num("[11, 2]"), "6": num("7")},
	{"5": num("[2]"), "6": num("[7, 9]")},
	{"5": num("[]")},
	{},
}

func keepPerson(cfg Config) []int {
	var out []int
	for _, i := range SortIndexes(personFields, cfg, len(personRecs), func(i int) map[string]json.RawMessage { return personRecs[i] }) {
		if Match(personFields, cfg, personRecs[i]) {
			out = append(out, i)
		}
	}
	return out
}

func TestPersonMembershipFilters(t *testing.T) {
	same := func(cfg Config, want []int) {
		t.Helper()
		if got := keepPerson(cfg); !intsEqual(got, want) {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
	same(Config{Filters: &Filters{Conj: "and", Rules: []Rule{{F: 5, Op: "contains", V: 2}}}}, []int{0, 1})
	// "1" must not substring-match "[11, 2]"; the legacy text path did.
	same(Config{Filters: &Filters{Conj: "and", Rules: []Rule{{F: 5, Op: "contains", V: 1}}}}, nil)
	same(Config{Filters: &Filters{Conj: "and", Rules: []Rule{{F: 5, Op: "contains", V: []any{float64(11), float64(3)}}}}}, []int{0})
	same(Config{Filters: &Filters{Conj: "and", Rules: []Rule{{F: 5, Op: "contains", V: "2"}}}}, []int{0, 1})
	same(Config{Filters: &Filters{Conj: "and", Rules: []Rule{{F: 5, Op: "not_contains", V: 2}}}}, []int{2, 3})
	same(Config{Filters: &Filters{Conj: "and", Rules: []Rule{{F: 6, Op: "is", V: 7}}}}, []int{0, 1})
	same(Config{Filters: &Filters{Conj: "and", Rules: []Rule{{F: 6, Op: "is_not", V: 7}}}}, []int{2, 3})
	same(Config{Filters: &Filters{Conj: "and", Rules: []Rule{{F: 5, Op: "empty"}}}}, []int{2, 3})
	same(Config{Filters: &Filters{Conj: "and", Rules: []Rule{{F: 5, Op: "not_empty"}}}}, []int{0, 1})
}

func TestPersonValidateRejectsNonMemberValues(t *testing.T) {
	for _, v := range []any{"abc", true, []any{"x"}, []any{true}} {
		cfg := Config{Filters: &Filters{Conj: "and", Rules: []Rule{{F: 5, Op: "contains", V: v}}}}
		if err := Validate(personFields, cfg); err == nil {
			t.Fatalf("contains %#v accepted", v)
		}
	}
	cfg := Config{Filters: &Filters{Conj: "and", Rules: []Rule{{F: 5, Op: "is", V: "x"}}}}
	if err := Validate(personFields, cfg); err == nil {
		t.Fatalf("is with text accepted")
	}
}

func TestPersonSortByFirstMember(t *testing.T) {
	got := keepPerson(Config{Sorts: []Sort{{F: 6, Asc: true}}})
	// Cell id 7 (scalar), then [7, 9] (first member 7, stable after the
	// scalar), empty cells last.
	if len(got) != 4 || got[0] != 0 || got[1] != 1 || got[2] != 2 || got[3] != 3 {
		t.Fatalf("sort order: %v", got)
	}
}

func TestPersonRuleSQLMembership(t *testing.T) {
	where, _, _, err := Compile(personFields, Config{Filters: &Filters{Conj: "and", Rules: []Rule{{F: 5, Op: "contains", V: []any{float64(2)}}}}})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"jsonb_array_elements_text", "= ANY(", "$1"} {
		if !strings.Contains(where, want) {
			t.Fatalf("where %q missing %q", where, want)
		}
	}
	if strings.Contains(where, "strpos") {
		t.Fatalf("person contains fell back to substring match: %s", where)
	}
}

func intsEqual(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
