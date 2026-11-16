package api

import (
	"bytes"
	"encoding/binary"
	"errors"
	"image"
	"image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"mime"
	"net/http"
	"strconv"

	"github.com/ZSeven-W/jiange/server/internal/blob"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

const (
	maxCoverBytes     = 20 << 20
	maxCoverDimension = 10000
	maxCoverPixels    = 25_000_000
	maxCoverGIFFrames = 128
	maxCoverGIFPixels = 40_000_000
)

var errInvalidCoverImage = errors.New("invalid cover image")

// Decoding a large raster may allocate substantially more than its compressed
// size. Bound concurrent reads and decodes across uploads and public previews.
// Requests beyond the budget fail promptly instead of queuing unbounded work.
var coverDecodeSlots = make(chan struct{}, 2)

func acquireCoverDecode(w http.ResponseWriter) (func(), bool) {
	select {
	case coverDecodeSlots <- struct{}{}:
		return func() { <-coverDecodeSlots }, true
	default:
		httpx.Error(w, http.StatusServiceUnavailable, "cover_busy", "封面图片处理繁忙，请稍后重试")
		return nil, false
	}
}

// validateCoverImage fully decodes a bounded raster before attachment. The
// declared MIME is not trusted; it must match the bytes and decoded format.
// GIF framing is scanned first to bound the work and memory of DecodeAll.
func validateCoverImage(data []byte, declaredMIME string) error {
	if len(data) == 0 || len(data) > maxCoverBytes {
		return errInvalidCoverImage
	}
	declared, _, err := mime.ParseMediaType(declaredMIME)
	if err != nil || (declared != "image/jpeg" && declared != "image/png" && declared != "image/gif") {
		return errInvalidCoverImage
	}
	if http.DetectContentType(data) != declared {
		return errInvalidCoverImage
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > maxCoverDimension || cfg.Height > maxCoverDimension || int64(cfg.Width)*int64(cfg.Height) > maxCoverPixels {
		return errInvalidCoverImage
	}
	switch {
	case declared == "image/jpeg" && format == "jpeg", declared == "image/png" && format == "png":
		_, actual, err := image.Decode(bytes.NewReader(data))
		if err != nil || actual != format {
			return errInvalidCoverImage
		}
	case declared == "image/gif" && format == "gif":
		if err := scanCoverGIF(data); err != nil {
			return errInvalidCoverImage
		}
		if _, err := gif.DecodeAll(bytes.NewReader(data)); err != nil {
			return errInvalidCoverImage
		}
	default:
		return errInvalidCoverImage
	}
	return nil
}

// scanCoverGIF walks the actual block framing without decompressing image data.
// Each frame is bounded before DecodeAll allocates its pixel buffers.
func scanCoverGIF(b []byte) error {
	if len(b) < 13 || (string(b[:6]) != "GIF87a" && string(b[:6]) != "GIF89a") {
		return errInvalidCoverImage
	}
	i := 13
	if b[10]&0x80 != 0 {
		i += 3 * (1 << ((b[10] & 7) + 1))
	}
	if i > len(b) {
		return errInvalidCoverImage
	}
	skipBlocks := func() bool {
		for i < len(b) {
			n := int(b[i])
			i++
			if n == 0 {
				return true
			}
			if n > len(b)-i {
				return false
			}
			i += n
		}
		return false
	}
	frames, total := 0, int64(0)
	for i < len(b) {
		marker := b[i]
		i++
		switch marker {
		case 0x3b: // trailer
			if frames == 0 {
				return errInvalidCoverImage
			}
			return nil
		case 0x21: // extension label followed by framed sub-blocks
			if i >= len(b) {
				return errInvalidCoverImage
			}
			i++
			if !skipBlocks() {
				return errInvalidCoverImage
			}
		case 0x2c:
			if len(b)-i < 9 {
				return errInvalidCoverImage
			}
			w := int(binary.LittleEndian.Uint16(b[i+4 : i+6]))
			h := int(binary.LittleEndian.Uint16(b[i+6 : i+8]))
			packed := b[i+8]
			i += 9
			if w <= 0 || h <= 0 || w > maxCoverDimension || h > maxCoverDimension {
				return errInvalidCoverImage
			}
			frames++
			total += int64(w) * int64(h)
			if frames > maxCoverGIFFrames || total > maxCoverGIFPixels {
				return errInvalidCoverImage
			}
			if packed&0x80 != 0 {
				i += 3 * (1 << ((packed & 7) + 1))
			}
			if i >= len(b) {
				return errInvalidCoverImage
			}
			i++ // LZW minimum code size
			if !skipBlocks() {
				return errInvalidCoverImage
			}
		default:
			return errInvalidCoverImage
		}
	}
	return errInvalidCoverImage
}

// requestedCoverRevision ties each preview URL to the selection originally
// shown to the caller. A newer cover must never be substituted at an old URL.
func requestedCoverRevision(r *http.Request) (int64, bool) {
	values, ok := r.URL.Query()["revision"]
	if !ok || len(values) != 1 || values[0] == "" {
		return 0, false
	}
	n, err := strconv.ParseInt(values[0], 10, 64)
	return n, err == nil && n >= 0 && n <= 9007199254740991
}

func coverPreviewHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}

func (s *Server) getDocCoverImage(w http.ResponseWriter, r *http.Request) {
	coverPreviewHeaders(w)
	d, ok := s.need(w, r, store.RoleView)
	if !ok {
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	revision, ok := requestedCoverRevision(r)
	if !ok {
		httpx.Error(w, http.StatusNotFound, "not_found", "封面不存在")
		return
	}
	check := func() (store.DocCover, error) {
		cover, err := s.Store.DocCoverGuarded(r.Context(), guard, d.ID)
		if err != nil {
			return store.DocCover{}, err
		}
		if cover.Kind != "file" || cover.FileID <= 0 || cover.Revision != revision {
			return store.DocCover{}, store.ErrNotFound
		}
		return cover, nil
	}
	cover, err := check()
	if err != nil {
		s.coverPreviewError(w, r, err)
		return
	}
	s.serveCoverImage(w, r, d.ID, cover, check)
}

func (s *Server) getPublicCoverImage(w http.ResponseWriter, r *http.Request) {
	coverPreviewHeaders(w)
	revision, ok := requestedCoverRevision(r)
	if !ok {
		httpx.Error(w, http.StatusNotFound, "not_found", "封面不存在")
		return
	}
	token := r.PathValue("token")
	docID, role, err := s.Store.DocByToken(r.Context(), token)
	if errors.Is(err, store.ErrNotFound) || err == nil && role != "anon" {
		s.coverPreviewError(w, r, store.ErrNotFound)
		return
	}
	if err != nil {
		s.coverPreviewError(w, r, err)
		return
	}
	check := func() (store.DocCover, error) {
		id, role, err := s.Store.DocByToken(r.Context(), token)
		if errors.Is(err, store.ErrNotFound) || err == nil && (id != docID || role != "anon") {
			return store.DocCover{}, store.ErrNotFound
		}
		if err != nil {
			return store.DocCover{}, err
		}
		cover, err := s.Store.DocCoverSystem(r.Context(), docID)
		if err != nil {
			return store.DocCover{}, err
		}
		id, role, err = s.Store.DocByToken(r.Context(), token)
		if errors.Is(err, store.ErrNotFound) || err == nil && (id != docID || role != "anon" || cover.Kind != "file" || cover.FileID <= 0 || cover.Revision != revision) {
			return store.DocCover{}, store.ErrNotFound
		}
		if err != nil {
			return store.DocCover{}, err
		}
		return cover, nil
	}
	cover, err := check()
	if err != nil {
		s.coverPreviewError(w, r, err)
		return
	}
	s.serveCoverImage(w, r, docID, cover, check)
}

func (s *Server) coverPreviewError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, store.ErrNotFound) || errors.Is(err, blob.ErrNotFound) || errors.Is(err, store.ErrForbidden) || errors.Is(err, store.ErrUnauthenticated) {
		httpx.Error(w, http.StatusNotFound, "not_found", "封面不存在或无权访问")
		return
	}
	s.fail(w, r, err)
}

func (s *Server) serveCoverImage(w http.ResponseWriter, r *http.Request, docID int64, expected store.DocCover, check func() (store.DocCover, error)) {
	if s.Blobs == nil {
		s.coverPreviewError(w, r, store.ErrNotFound)
		return
	}
	file, err := s.Store.GetFile(r.Context(), expected.FileID)
	if err != nil || file.DocID != docID || file.Size <= 0 || file.Size > maxCoverBytes {
		if err == nil || errors.Is(err, store.ErrNotFound) {
			err = store.ErrNotFound
		}
		s.coverPreviewError(w, r, err)
		return
	}
	current, err := check()
	if err != nil || current.FileID != expected.FileID || current.Revision != expected.Revision {
		if err == nil {
			err = store.ErrNotFound
		}
		s.coverPreviewError(w, r, err)
		return
	}
	release, ok := acquireCoverDecode(w)
	if !ok {
		return
	}
	defer release()
	reader, err := s.Blobs.Get(r.Context(), file.ObjectKey)
	if err != nil {
		s.coverPreviewError(w, r, err)
		return
	}
	defer reader.Close()
	data, err := io.ReadAll(io.LimitReader(reader, maxCoverBytes+1))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if int64(len(data)) != file.Size || validateCoverImage(data, file.Mime) != nil {
		s.coverPreviewError(w, r, store.ErrNotFound)
		return
	}
	current, err = check()
	if err != nil || current.FileID != expected.FileID || current.Revision != expected.Revision {
		if err == nil {
			err = store.ErrNotFound
		}
		s.coverPreviewError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", http.DetectContentType(data))
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Header().Set("Content-Disposition", "inline")
	_, _ = w.Write(data)
}
