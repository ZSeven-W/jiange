package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"regexp"
	"slices"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	maxSlidePageMetaBytes   = 64 * 1024
	maxSlideShapeGroups     = 100
	maxSlideGroupMembers    = 100
	maxSlideShapeAnimations = 100
	defaultSlideAnimMs      = 450
)

// ErrInvalidSlideMeta reports malformed, oversized, or out-of-range page metadata.
var ErrInvalidSlideMeta = errors.New("store: invalid slide page metadata")

var (
	slideMetaHexColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
	slideMetaID       = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)
)

// SlideFieldTextStyleMeta carries per-field typography overrides for slide title or body.
type SlideFieldTextStyleMeta struct {
	FontSize *float64 `json:"fontSize,omitempty"`
	Bold     *bool    `json:"bold,omitempty"`
	Italic   *bool    `json:"italic,omitempty"`
	Color    *string  `json:"color,omitempty"`
	Align    *string  `json:"align,omitempty"`
}

// SlideShapeAnimationMeta carries per-shape animation configuration for a single slide page.
type SlideShapeAnimationMeta struct {
	Effect     string `json:"effect"`               // fade-in | slide-up | zoom-in | bounce | pulse | fade-out
	Order      int    `json:"order"`                // 1..100
	DurationMs int    `json:"durationMs,omitempty"` // 100..5000 (default 450)
	Trigger    string `json:"trigger,omitempty"`    // click | with_prev | after_prev (default "click")
}

// SlidePageMeta carries cloud-persisted presentation metadata for a single slide page.
type SlidePageMeta struct {
	TitleStyle  *SlideFieldTextStyleMeta           `json:"titleStyle,omitempty"`
	BodyStyle   *SlideFieldTextStyleMeta           `json:"bodyStyle,omitempty"`
	Transition  *string                            `json:"transition,omitempty"`
	ShapeGroups map[string][]string                `json:"shapeGroups,omitempty"`
	Animations  map[string]SlideShapeAnimationMeta `json:"animations,omitempty"`
}

// SlidesMetaStore persists slide page styling, transitions, and shape groups
// independently from content revisions so text/shape editing never falsely conflicts.
type SlidesMetaStore interface {
	UpdateSlidesPageMeta(ctx context.Context, guard RestoreGuard, slidesID, pageID int64, meta json.RawMessage) (SlidesPage, error)
	BatchUpdateSlidesPagesMeta(ctx context.Context, guard RestoreGuard, slidesID int64, patch json.RawMessage) ([]SlidesPage, error)
}

func normalizeDBSlideMeta(raw json.RawMessage) json.RawMessage {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("{}")) || bytes.Equal(trimmed, []byte("null")) {
		return nil
	}
	if trimmed[0] == '{' && trimmed[len(trimmed)-1] == '}' && len(bytes.TrimSpace(trimmed[1:len(trimmed)-1])) == 0 {
		return nil
	}
	return slices.Clone(trimmed)
}

func slideMetaForPG(raw json.RawMessage) string {
	norm := normalizeDBSlideMeta(raw)
	if len(norm) == 0 {
		return "{}"
	}
	return string(norm)
}

func cloneSlideMeta(raw json.RawMessage) json.RawMessage {
	return normalizeDBSlideMeta(raw)
}

func normalizeSlideFieldTextStyle(in *SlideFieldTextStyleMeta) (*SlideFieldTextStyleMeta, error) {
	if in == nil {
		return nil, nil
	}
	var out SlideFieldTextStyleMeta
	if in.FontSize != nil {
		v := *in.FontSize
		if math.IsNaN(v) || math.IsInf(v, 0) || v < 12 || v > 120 {
			return nil, ErrInvalidSlideMeta
		}
		out.FontSize = &v
	}
	if in.Bold != nil {
		v := *in.Bold
		out.Bold = &v
	}
	if in.Italic != nil {
		v := *in.Italic
		out.Italic = &v
	}
	if in.Color != nil {
		v := *in.Color
		if !slideMetaHexColor.MatchString(v) {
			return nil, ErrInvalidSlideMeta
		}
		out.Color = &v
	}
	if in.Align != nil {
		v := *in.Align
		switch v {
		case "left", "center", "right":
			out.Align = &v
		default:
			return nil, ErrInvalidSlideMeta
		}
	}
	if out.FontSize == nil && out.Bold == nil && out.Italic == nil && out.Color == nil && out.Align == nil {
		return nil, nil
	}
	return &out, nil
}

func validSlideTransition(v string) bool {
	switch v {
	case "none", "fade", "push", "wipe":
		return true
	}
	return false
}

func normalizeSlideShapeGroups(in map[string][]string) (map[string][]string, error) {
	if in == nil {
		return nil, nil
	}
	if len(in) > maxSlideShapeGroups {
		return nil, ErrInvalidSlideMeta
	}
	out := make(map[string][]string, len(in))
	for groupID, members := range in {
		if !slideMetaID.MatchString(groupID) || len(members) > maxSlideGroupMembers {
			return nil, ErrInvalidSlideMeta
		}
		seen := make(map[string]bool, len(members))
		clean := make([]string, 0, len(members))
		for _, memberID := range members {
			if !slideMetaID.MatchString(memberID) {
				return nil, ErrInvalidSlideMeta
			}
			if !seen[memberID] {
				seen[memberID] = true
				clean = append(clean, memberID)
			}
		}
		if len(clean) > 0 {
			out[groupID] = clean
		}
	}
	if len(out) == 0 {
		return nil, nil
	}
	return out, nil
}

func validSlideAnimationEffect(v string) bool {
	switch v {
	case "fade-in", "slide-up", "zoom-in", "bounce", "pulse", "fade-out":
		return true
	}
	return false
}

func validSlideAnimationTrigger(v string) bool {
	switch v {
	case "click", "with_prev", "after_prev":
		return true
	}
	return false
}

func normalizeSlideShapeAnimations(in map[string]SlideShapeAnimationMeta) (map[string]SlideShapeAnimationMeta, error) {
	if in == nil {
		return nil, nil
	}
	if len(in) > maxSlideShapeAnimations {
		return nil, ErrInvalidSlideMeta
	}
	out := make(map[string]SlideShapeAnimationMeta, len(in))
	for shapeID, anim := range in {
		if !slideMetaID.MatchString(shapeID) {
			return nil, ErrInvalidSlideMeta
		}
		if !validSlideAnimationEffect(anim.Effect) {
			return nil, ErrInvalidSlideMeta
		}
		if anim.Order < 1 || anim.Order > maxSlideShapeAnimations {
			return nil, ErrInvalidSlideMeta
		}
		durationMs := anim.DurationMs
		if durationMs == 0 {
			durationMs = defaultSlideAnimMs
		} else if durationMs < 100 || durationMs > 5000 {
			return nil, ErrInvalidSlideMeta
		}
		trigger := anim.Trigger
		if trigger == "" {
			trigger = "click"
		} else if !validSlideAnimationTrigger(trigger) {
			return nil, ErrInvalidSlideMeta
		}
		out[shapeID] = SlideShapeAnimationMeta{
			Effect:     anim.Effect,
			Order:      anim.Order,
			DurationMs: durationMs,
			Trigger:    trigger,
		}
	}
	if len(out) == 0 {
		return nil, nil
	}
	return out, nil
}

func encodeNormalizedSlidePageMeta(m SlidePageMeta) (json.RawMessage, error) {
	if m.TitleStyle == nil && m.BodyStyle == nil && m.Transition == nil && len(m.ShapeGroups) == 0 && len(m.Animations) == 0 {
		return nil, nil
	}
	encoded, err := json.Marshal(m)
	if err != nil || len(encoded) > maxSlidePageMetaBytes {
		return nil, ErrInvalidSlideMeta
	}
	return encoded, nil
}

func decodeStrictJSON(raw []byte, dst any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return ErrInvalidSlideMeta
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return ErrInvalidSlideMeta
	}
	return nil
}

// ValidateAndNormalizeSlidePageMeta validates a slide page metadata JSON object
// and returns compact normalized JSON, or nil if the normalized object is empty.
func ValidateAndNormalizeSlidePageMeta(raw json.RawMessage) (json.RawMessage, error) {
	if len(raw) > maxSlidePageMetaBytes {
		return nil, ErrInvalidSlideMeta
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) || bytes.Equal(trimmed, []byte("{}")) {
		return nil, nil
	}
	if trimmed[0] != '{' {
		return nil, ErrInvalidSlideMeta
	}
	var in SlidePageMeta
	if err := decodeStrictJSON(trimmed, &in); err != nil {
		return nil, ErrInvalidSlideMeta
	}
	titleStyle, err := normalizeSlideFieldTextStyle(in.TitleStyle)
	if err != nil {
		return nil, err
	}
	bodyStyle, err := normalizeSlideFieldTextStyle(in.BodyStyle)
	if err != nil {
		return nil, err
	}
	var transition *string
	if in.Transition != nil {
		v := *in.Transition
		if !validSlideTransition(v) {
			return nil, ErrInvalidSlideMeta
		}
		if v != "none" {
			transition = &v
		}
	}
	groups, err := normalizeSlideShapeGroups(in.ShapeGroups)
	if err != nil {
		return nil, err
	}
	animations, err := normalizeSlideShapeAnimations(in.Animations)
	if err != nil {
		return nil, err
	}
	return encodeNormalizedSlidePageMeta(SlidePageMeta{
		TitleStyle:  titleStyle,
		BodyStyle:   bodyStyle,
		Transition:  transition,
		ShapeGroups: groups,
		Animations:  animations,
	})
}

type slideBatchMetaPatch struct {
	hasTitleStyle bool
	titleStyle    *SlideFieldTextStyleMeta
	hasBodyStyle  bool
	bodyStyle     *SlideFieldTextStyleMeta
	hasTransition bool
	transition    *string
}

func parseSlideBatchMetaPatch(raw json.RawMessage) (slideBatchMetaPatch, error) {
	if len(raw) > maxSlidePageMetaBytes {
		return slideBatchMetaPatch{}, ErrInvalidSlideMeta
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) || bytes.Equal(trimmed, []byte("{}")) {
		return slideBatchMetaPatch{}, nil
	}
	if trimmed[0] != '{' {
		return slideBatchMetaPatch{}, ErrInvalidSlideMeta
	}
	// First check strictly that only allowed top-level keys exist and JSON is valid.
	var strict struct {
		TitleStyle *SlideFieldTextStyleMeta `json:"titleStyle"`
		BodyStyle  *SlideFieldTextStyleMeta `json:"bodyStyle"`
		Transition *string                  `json:"transition"`
	}
	if err := decodeStrictJSON(trimmed, &strict); err != nil {
		return slideBatchMetaPatch{}, ErrInvalidSlideMeta
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &keys); err != nil {
		return slideBatchMetaPatch{}, ErrInvalidSlideMeta
	}
	var patch slideBatchMetaPatch
	if rawVal, ok := keys["titleStyle"]; ok {
		patch.hasTitleStyle = true
		if !bytes.Equal(bytes.TrimSpace(rawVal), []byte("null")) {
			style, err := normalizeSlideFieldTextStyle(strict.TitleStyle)
			if err != nil {
				return slideBatchMetaPatch{}, err
			}
			patch.titleStyle = style
		}
	}
	if rawVal, ok := keys["bodyStyle"]; ok {
		patch.hasBodyStyle = true
		if !bytes.Equal(bytes.TrimSpace(rawVal), []byte("null")) {
			style, err := normalizeSlideFieldTextStyle(strict.BodyStyle)
			if err != nil {
				return slideBatchMetaPatch{}, err
			}
			patch.bodyStyle = style
		}
	}
	if rawVal, ok := keys["transition"]; ok {
		patch.hasTransition = true
		if !bytes.Equal(bytes.TrimSpace(rawVal), []byte("null")) {
			if strict.Transition == nil || !validSlideTransition(*strict.Transition) {
				return slideBatchMetaPatch{}, ErrInvalidSlideMeta
			}
			v := *strict.Transition
			if v != "none" {
				patch.transition = &v
			}
		}
	}
	return patch, nil
}

func mergeSlideFieldTextStyle(base, patch *SlideFieldTextStyleMeta) *SlideFieldTextStyleMeta {
	if patch == nil {
		return base
	}
	var out SlideFieldTextStyleMeta
	if base != nil {
		out = *base
	}
	if patch.FontSize != nil {
		v := *patch.FontSize
		out.FontSize = &v
	}
	if patch.Bold != nil {
		v := *patch.Bold
		out.Bold = &v
	}
	if patch.Italic != nil {
		v := *patch.Italic
		out.Italic = &v
	}
	if patch.Color != nil {
		v := *patch.Color
		out.Color = &v
	}
	if patch.Align != nil {
		v := *patch.Align
		out.Align = &v
	}
	if out.FontSize == nil && out.Bold == nil && out.Italic == nil && out.Color == nil && out.Align == nil {
		return nil
	}
	return &out
}

func mergeSlidePageMeta(existing json.RawMessage, patch slideBatchMetaPatch) (json.RawMessage, error) {
	var cur SlidePageMeta
	if norm := normalizeDBSlideMeta(existing); len(norm) > 0 {
		if err := json.Unmarshal(norm, &cur); err != nil {
			// Fall back cleanly if legacy malformed data ever existed.
			cur = SlidePageMeta{}
		}
	}
	if patch.hasTitleStyle {
		if patch.titleStyle == nil {
			cur.TitleStyle = nil
		} else {
			cur.TitleStyle = mergeSlideFieldTextStyle(cur.TitleStyle, patch.titleStyle)
		}
	}
	if patch.hasBodyStyle {
		if patch.bodyStyle == nil {
			cur.BodyStyle = nil
		} else {
			cur.BodyStyle = mergeSlideFieldTextStyle(cur.BodyStyle, patch.bodyStyle)
		}
	}
	if patch.hasTransition {
		cur.Transition = patch.transition
	}
	// Always preserve cur.ShapeGroups and cur.Animations untouched.
	return encodeNormalizedSlidePageMeta(cur)
}

func (m *Memory) UpdateSlidesPageMeta(ctx context.Context, g RestoreGuard, slidesID, pageID int64, rawMeta json.RawMessage) (SlidesPage, error) {
	normalized, err := ValidateAndNormalizeSlidePageMeta(rawMeta)
	if err != nil {
		return SlidesPage{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, err := m.slidesAccessLocked(ctx, g, slidesID, false); err != nil {
		return SlidesPage{}, err
	}
	i, p := m.findSlidesPageLocked(pageID)
	if p == nil || p.SlidesID != slidesID {
		return SlidesPage{}, ErrNotFound
	}
	m.slides[i].Meta = cloneSlideMeta(normalized)
	m.slides[i].UpdatedAt = time.Now()
	result := m.slides[i]
	result.Shapes = slices.Clone(result.Shapes)
	result.Meta = cloneSlideMeta(result.Meta)
	return result, nil
}

func (m *Memory) BatchUpdateSlidesPagesMeta(ctx context.Context, g RestoreGuard, slidesID int64, rawPatch json.RawMessage) ([]SlidesPage, error) {
	patch, err := parseSlideBatchMetaPatch(rawPatch)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, err := m.slidesAccessLocked(ctx, g, slidesID, false); err != nil {
		return nil, err
	}
	type planned struct {
		idx  int
		meta json.RawMessage
	}
	var updates []planned
	for i := range m.slides {
		if m.slides[i].SlidesID != slidesID {
			continue
		}
		merged, err := mergeSlidePageMeta(m.slides[i].Meta, patch)
		if err != nil {
			return nil, err
		}
		updates = append(updates, planned{idx: i, meta: merged})
	}
	now := time.Now()
	out := make([]SlidesPage, 0, len(updates))
	for _, u := range updates {
		m.slides[u.idx].Meta = cloneSlideMeta(u.meta)
		m.slides[u.idx].UpdatedAt = now
		page := m.slides[u.idx]
		page.Shapes = slices.Clone(page.Shapes)
		page.Meta = cloneSlideMeta(page.Meta)
		out = append(out, page)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Pos == out[j].Pos {
			return out[i].ID < out[j].ID
		}
		return out[i].Pos < out[j].Pos
	})
	return out, nil
}

func (p *Postgres) UpdateSlidesPageMeta(ctx context.Context, g RestoreGuard, slidesID, pageID int64, rawMeta json.RawMessage) (page SlidesPage, err error) {
	normalized, err := ValidateAndNormalizeSlidePageMeta(rawMeta)
	if err != nil {
		return SlidesPage{}, err
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		var existingSlidesID int64
		e := tx.QueryRow(ctx, `SELECT slides_id FROM slides_pages WHERE id=$1 AND slides_id=$2 FOR UPDATE`, pageID, slidesID).Scan(&existingSlidesID)
		if errors.Is(e, pgx.ErrNoRows) {
			if ae := p.slidesAccessGuarded(ctx, tx, g, slidesID); ae != nil {
				return ae
			}
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		if e = p.slidesAccessGuarded(ctx, tx, g, slidesID); e != nil {
			return e
		}
		e = tx.QueryRow(ctx, `UPDATE slides_pages SET meta=$2::jsonb, updated_at=now() WHERE id=$1 AND slides_id=$3
			RETURNING id, slides_id, pos, title, body, background, notes, shapes, hidden, layout, meta, revision, updated_at`,
			pageID, slideMetaForPG(normalized), slidesID).
			Scan(&page.ID, &page.SlidesID, &page.Pos, &page.Title, &page.Body, &page.Background, &page.Notes, &page.Shapes, &page.Hidden, &page.Layout, &page.Meta, &page.Revision, &page.UpdatedAt)
		if e != nil {
			return e
		}
		page.Meta = normalizeDBSlideMeta(page.Meta)
		return nil
	})
	if err != nil {
		return SlidesPage{}, err
	}
	return page, nil
}

func (p *Postgres) BatchUpdateSlidesPagesMeta(ctx context.Context, g RestoreGuard, slidesID int64, rawPatch json.RawMessage) (out []SlidesPage, err error) {
	patch, err := parseSlideBatchMetaPatch(rawPatch)
	if err != nil {
		return nil, err
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		// Lock existing page rows in stable id order before locking the deck node,
		// matching ReorderSlides and ApplySlidesBackgroundChanges to avoid deadlocks.
		lockRows, e := tx.Query(ctx, `SELECT id FROM slides_pages WHERE slides_id=$1 ORDER BY id FOR UPDATE`, slidesID)
		if e != nil {
			return e
		}
		for lockRows.Next() {
			var id int64
			if e = lockRows.Scan(&id); e != nil {
				lockRows.Close()
				return e
			}
		}
		e = lockRows.Err()
		lockRows.Close()
		if e != nil {
			return e
		}
		var nodeID int64
		if e = tx.QueryRow(ctx, `SELECT id FROM nodes WHERE id=$1 FOR UPDATE`, slidesID).Scan(&nodeID); errors.Is(e, pgx.ErrNoRows) {
			if ae := p.slidesAccessGuarded(ctx, tx, g, slidesID); ae != nil {
				return ae
			}
			return ErrNotFound
		} else if e != nil {
			return e
		}
		if e = p.slidesAccessGuarded(ctx, tx, g, slidesID); e != nil {
			return e
		}
		rows, e := tx.Query(ctx, `SELECT id, meta FROM slides_pages WHERE slides_id=$1 ORDER BY id FOR UPDATE`, slidesID)
		if e != nil {
			return e
		}
		type pageRow struct {
			id   int64
			meta json.RawMessage
		}
		var existing []pageRow
		for rows.Next() {
			var r pageRow
			if e = rows.Scan(&r.id, &r.meta); e != nil {
				rows.Close()
				return e
			}
			existing = append(existing, r)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		type planned struct {
			id   int64
			meta json.RawMessage
		}
		updates := make([]planned, 0, len(existing))
		for _, r := range existing {
			merged, e := mergeSlidePageMeta(r.meta, patch)
			if e != nil {
				return e
			}
			updates = append(updates, planned{id: r.id, meta: merged})
		}
		for _, u := range updates {
			if _, e = tx.Exec(ctx, `UPDATE slides_pages SET meta=$2::jsonb, updated_at=now() WHERE id=$1 AND slides_id=$3`, u.id, slideMetaForPG(u.meta), slidesID); e != nil {
				return e
			}
		}
		allRows, e := tx.Query(ctx, `SELECT id, slides_id, pos, title, body, background, notes, shapes, hidden, layout, meta, revision, updated_at FROM slides_pages WHERE slides_id=$1 ORDER BY pos, id`, slidesID)
		if e != nil {
			return e
		}
		out = make([]SlidesPage, 0, len(updates))
		for allRows.Next() {
			var pg SlidesPage
			if e = allRows.Scan(&pg.ID, &pg.SlidesID, &pg.Pos, &pg.Title, &pg.Body, &pg.Background, &pg.Notes, &pg.Shapes, &pg.Hidden, &pg.Layout, &pg.Meta, &pg.Revision, &pg.UpdatedAt); e != nil {
				allRows.Close()
				return e
			}
			pg.Meta = normalizeDBSlideMeta(pg.Meta)
			out = append(out, pg)
		}
		e = allRows.Err()
		allRows.Close()
		return e
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
