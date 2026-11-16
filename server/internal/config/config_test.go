package config

import "testing"

func TestConditionalCancelRequiresExplicitEnable(t *testing.T) {
	for _, tc := range []struct {
		value string
		want  bool
	}{{"", false}, {"false", false}, {"1", false}, {"true", true}} {
		t.Run(tc.value, func(t *testing.T) {
			t.Setenv("JIANGE_ENABLE_CONDITIONAL_CANCEL", tc.value)
			if got := Load().EnableConditionalCancel; got != tc.want {
				t.Fatalf("enabled = %v; want %v", got, tc.want)
			}
		})
	}
}
