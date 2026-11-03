package migrate

import "testing"

func TestListOrdered(t *testing.T) {
	ms, err := List()
	if err != nil {
		t.Fatal(err)
	}
	if len(ms) < 2 || ms[0].Version != 1 || ms[1].Version != 2 {
		t.Fatalf("unexpected migrations: %+v", ms)
	}
}
