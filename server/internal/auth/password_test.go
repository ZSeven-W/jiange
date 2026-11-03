package auth

import "testing"

func TestHashVerify(t *testing.T) {
	h, err := HashPassword("correct horse", 1000)
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := VerifyPassword("correct horse", h); !ok || err != nil {
		t.Fatalf("verify failed: %v %v", ok, err)
	}
	if ok, _ := VerifyPassword("wrong", h); ok {
		t.Fatal("wrong password accepted")
	}
	h2, _ := HashPassword("correct horse", 1000)
	if h == h2 {
		t.Fatal("salt not random")
	}
	for _, bad := range []string{"", "x$1$a$b", "pbkdf2-sha256$0$AA$AA", "pbkdf2-sha256$10$!!$AA"} {
		if _, err := VerifyPassword("x", bad); err == nil {
			t.Fatalf("expected error for %q", bad)
		}
	}
}

func TestToken(t *testing.T) {
	a, ha, _ := NewToken()
	b, _, _ := NewToken()
	if a == b || len(a) < 40 || string(HashToken(a)) != string(ha) {
		t.Fatal("bad token")
	}
}
