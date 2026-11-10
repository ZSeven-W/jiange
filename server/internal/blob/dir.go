package blob

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// ErrBadKey is returned when a key would escape the store directory.
var ErrBadKey = errors.New("blob: invalid key")

// Dir is a filesystem blob store rooted at Root. Keys must be slash-separated
// relative paths whose elements are [A-Za-z0-9._-]+ (the form the API already
// writes: docs/<id>/<hex>, drive/<ws>/<hex>, slides/<id>/<hex>).
type Dir struct {
	Root string
}

// NewDir creates root if missing (mode 0700) and returns a store rooted there.
func NewDir(root string) (*Dir, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(abs, 0o700); err != nil {
		return nil, err
	}
	return &Dir{Root: abs}, nil
}

func (d *Dir) resolve(key string) (string, error) {
	if key == "" || !utf8.ValidString(key) || strings.Contains(key, `\`) || strings.HasPrefix(key, "/") {
		return "", ErrBadKey
	}
	parts := strings.Split(key, "/")
	for _, p := range parts {
		if p == "" || p == "." || p == ".." {
			return "", ErrBadKey
		}
		for _, r := range p {
			ok := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.'
			if !ok {
				return "", ErrBadKey
			}
		}
	}
	p := filepath.Join(append([]string{d.Root}, parts...)...)
	rel, err := filepath.Rel(d.Root, p)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", ErrBadKey
	}
	return p, nil
}

func (d *Dir) Put(ctx context.Context, key, _ string, body []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	p, err := d.resolve(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	ok := false
	defer func() {
		if !ok {
			_ = os.Remove(tmpName)
		}
	}()
	if _, err := tmp.Write(body); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, p); err != nil {
		return err
	}
	ok = true
	return nil
}

func (d *Dir) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	p, err := d.resolve(key)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	if st.IsDir() {
		f.Close()
		return nil, ErrNotFound
	}
	return f, nil
}

func (d *Dir) Delete(ctx context.Context, key string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	p, err := d.resolve(key)
	if err != nil {
		return err
	}
	err = os.Remove(p)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (d *Dir) Size(ctx context.Context, key string) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	p, err := d.resolve(key)
	if err != nil {
		return 0, err
	}
	st, err := os.Stat(p)
	if errors.Is(err, os.ErrNotExist) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	if st.IsDir() {
		return 0, ErrNotFound
	}
	return st.Size(), nil
}
