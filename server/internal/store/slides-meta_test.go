package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestValidateAndNormalizeSlidePageMeta(t *testing.T) {
	t.Run("empty and default normalize to nil", func(t *testing.T) {
		for _, raw := range []string{
			"",
			"null",
			"{}",
			" { } ",
			`{"titleStyle":{},"bodyStyle":{},"transition":"none","shapeGroups":{}}`,
			`{"shapeGroups":{"g1":[]}}`,
			`{"animations":{}}`,
		} {
			got, err := store.ValidateAndNormalizeSlidePageMeta(json.RawMessage(raw))
			if err != nil {
				t.Fatalf("raw=%q unexpected err: %v", raw, err)
			}
			if got != nil {
				t.Fatalf("raw=%q got=%s want nil", raw, got)
			}
		}
	})

	t.Run("valid rich metadata normalizes cleanly", func(t *testing.T) {
		raw := json.RawMessage(`{
			"titleStyle": {"fontSize": 48, "bold": true, "italic": false, "color": "#3370ff", "align": "center"},
			"bodyStyle": {"fontSize": 22, "color": "#4e5969", "align": "left"},
			"transition": "wipe",
			"shapeGroups": {"grp-1": ["s1", "s2", "s1"], "grp_2": ["a", "b"]},
			"animations": {
				"s1": {"effect": "fade-in", "order": 1},
				"s2": {"effect": "slide-up", "order": 2, "durationMs": 700, "trigger": "with_prev"},
				"s3": {"effect": "fade-out", "order": 3, "durationMs": 300, "trigger": "after_prev"}
			}
		}`)
		got, err := store.ValidateAndNormalizeSlidePageMeta(raw)
		if err != nil {
			t.Fatalf("unexpected err: %v", err)
		}
		var parsed store.SlidePageMeta
		if err := json.Unmarshal(got, &parsed); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if parsed.TitleStyle == nil || *parsed.TitleStyle.FontSize != 48 || !*parsed.TitleStyle.Bold || *parsed.TitleStyle.Color != "#3370ff" || *parsed.TitleStyle.Align != "center" {
			t.Fatalf("titleStyle: %+v", parsed.TitleStyle)
		}
		if parsed.BodyStyle == nil || *parsed.BodyStyle.FontSize != 22 || *parsed.BodyStyle.Color != "#4e5969" || *parsed.BodyStyle.Align != "left" {
			t.Fatalf("bodyStyle: %+v", parsed.BodyStyle)
		}
		if parsed.Transition == nil || *parsed.Transition != "wipe" {
			t.Fatalf("transition: %+v", parsed.Transition)
		}
		if !reflect.DeepEqual(parsed.ShapeGroups["grp-1"], []string{"s1", "s2"}) {
			t.Fatalf("deduped group: %+v", parsed.ShapeGroups)
		}
		if gotAnim := parsed.Animations["s1"]; gotAnim.Effect != "fade-in" || gotAnim.Order != 1 || gotAnim.DurationMs != 450 || gotAnim.Trigger != "click" {
			t.Fatalf("s1 animation defaults: %+v", gotAnim)
		}
		if gotAnim := parsed.Animations["s2"]; gotAnim.Effect != "slide-up" || gotAnim.Order != 2 || gotAnim.DurationMs != 700 || gotAnim.Trigger != "with_prev" {
			t.Fatalf("s2 animation: %+v", gotAnim)
		}
		if gotAnim := parsed.Animations["s3"]; gotAnim.Effect != "fade-out" || gotAnim.Order != 3 || gotAnim.DurationMs != 300 || gotAnim.Trigger != "after_prev" {
			t.Fatalf("s3 animation: %+v", gotAnim)
		}
	})

	t.Run("rejects invalid fields and oversized payloads", func(t *testing.T) {
		manyGroups := make(map[string][]string, 101)
		for i := range 101 {
			manyGroups[fmt.Sprintf("g-%d", i)] = []string{"s1", "s2"}
		}
		manyGroupsRaw, _ := json.Marshal(map[string]any{"shapeGroups": manyGroups})

		manyMembers := make([]string, 101)
		for i := range 101 {
			manyMembers[i] = fmt.Sprintf("s-%d", i)
		}
		manyMembersRaw, _ := json.Marshal(map[string]any{"shapeGroups": map[string][]string{"g1": manyMembers}})

		manyAnims := make(map[string]store.SlideShapeAnimationMeta, 101)
		for i := range 101 {
			manyAnims[fmt.Sprintf("shape-%d", i)] = store.SlideShapeAnimationMeta{Effect: "fade-in", Order: 1}
		}
		manyAnimsRaw, _ := json.Marshal(map[string]any{"animations": manyAnims})

		giantRaw := json.RawMessage(`{"transition":"fade","pad":"` + strings.Repeat("a", 65*1024) + `"}`)

		invalidCases := []struct {
			name string
			raw  json.RawMessage
		}{
			{"array instead of object", json.RawMessage(`[]`)},
			{"unknown top-level key", json.RawMessage(`{"unknown":1}`)},
			{"unknown nested key", json.RawMessage(`{"titleStyle":{"underline":true}}`)},
			{"fontSize too small", json.RawMessage(`{"titleStyle":{"fontSize":11}}`)},
			{"fontSize too large", json.RawMessage(`{"bodyStyle":{"fontSize":121}}`)},
			{"invalid color name", json.RawMessage(`{"titleStyle":{"color":"red"}}`)},
			{"short hex color", json.RawMessage(`{"titleStyle":{"color":"#fff"}}`)},
			{"invalid align", json.RawMessage(`{"bodyStyle":{"align":"justify"}}`)},
			{"invalid transition", json.RawMessage(`{"transition":"zoom"}`)},
			{"invalid group id", json.RawMessage(`{"shapeGroups":{"bad id!":["s1","s2"]}}`)},
			{"invalid member id", json.RawMessage(`{"shapeGroups":{"g1":["s1","bad id!"]}}`)},
			{"too many groups", manyGroupsRaw},
			{"too many group members", manyMembersRaw},
			{"invalid animation shape id", json.RawMessage(`{"animations":{"bad id!":{"effect":"fade-in","order":1}}}`)},
			{"invalid animation effect", json.RawMessage(`{"animations":{"s1":{"effect":"spin","order":1}}}`)},
			{"missing animation effect", json.RawMessage(`{"animations":{"s1":{"order":1}}}`)},
			{"animation order too small", json.RawMessage(`{"animations":{"s1":{"effect":"fade-in","order":0}}}`)},
			{"animation order too large", json.RawMessage(`{"animations":{"s1":{"effect":"fade-in","order":101}}}`)},
			{"animation duration too small", json.RawMessage(`{"animations":{"s1":{"effect":"fade-in","order":1,"durationMs":99}}}`)},
			{"animation duration negative", json.RawMessage(`{"animations":{"s1":{"effect":"fade-in","order":1,"durationMs":-10}}}`)},
			{"animation duration too large", json.RawMessage(`{"animations":{"s1":{"effect":"fade-in","order":1,"durationMs":5001}}}`)},
			{"invalid animation trigger", json.RawMessage(`{"animations":{"s1":{"effect":"fade-in","order":1,"trigger":"hover"}}}`)},
			{"unknown animation nested key", json.RawMessage(`{"animations":{"s1":{"effect":"fade-in","order":1,"delay":100}}}`)},
			{"too many animations", manyAnimsRaw},
			{"oversized payload", giantRaw},
			{"trailing junk", json.RawMessage(`{"transition":"fade"}{}`)},
		}
		for _, tc := range invalidCases {
			t.Run(tc.name, func(t *testing.T) {
				if _, err := store.ValidateAndNormalizeSlidePageMeta(tc.raw); !errors.Is(err, store.ErrInvalidSlideMeta) {
					t.Fatalf("%s: err=%v want ErrInvalidSlideMeta", tc.name, err)
				}
			})
		}
	})
}

func exerciseSlidesMeta(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	op := st.(store.SlidesMetaStore)

	owner, ws, err := st.CreateUser(ctx, "slides-meta-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	g := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("slides-meta-owner")}
	if err := st.CreateSession(ctx, g.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	deck, err := st.CreateDriveNode(ctx, g, ws.ID, nil, "slides", "Meta Deck", true)
	if err != nil {
		t.Fatal(err)
	}
	pages, err := st.ListSlidesPages(ctx, owner.ID, deck.ID)
	if err != nil || len(pages) != 1 {
		t.Fatalf("initial pages: %+v %v", pages, err)
	}
	// Untouched page omits "meta" completely in JSON.
	if pages[0].Meta != nil {
		t.Fatalf("untouched page should have nil Meta, got %s", pages[0].Meta)
	}
	encodedUntouched, err := json.Marshal(pages[0])
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encodedUntouched), `"meta"`) {
		t.Fatalf("untouched page JSON should omit meta key: %s", encodedUntouched)
	}

	p1 := pages[0]
	p2, err := st.InsertSlidesPage(ctx, g, deck.ID, p1.ID, p1.Revision)
	if err != nil {
		t.Fatal(err)
	}

	// Save full page metadata on page 1 without bumping revision.
	meta1 := json.RawMessage(`{"titleStyle":{"fontSize":48,"bold":true,"color":"#112233","align":"center"},"bodyStyle":{"italic":true},"transition":"fade","shapeGroups":{"grp-1":["shape-a","shape-b"]},"animations":{"shape-a":{"effect":"zoom-in","order":1,"durationMs":500,"trigger":"click"},"shape-b":{"effect":"pulse","order":2,"trigger":"with_prev"}}}`)
	saved1, err := op.UpdateSlidesPageMeta(ctx, g, deck.ID, p1.ID, meta1)
	if err != nil {
		t.Fatalf("update meta: %v", err)
	}
	if saved1.Revision != p1.Revision {
		t.Fatalf("meta update must not bump revision: got %d want %d", saved1.Revision, p1.Revision)
	}
	var parsed1 store.SlidePageMeta
	if err := json.Unmarshal(saved1.Meta, &parsed1); err != nil {
		t.Fatalf("unmarshal saved meta: %v", err)
	}
	if parsed1.TitleStyle == nil || *parsed1.TitleStyle.FontSize != 48 || *parsed1.TitleStyle.Color != "#112233" || parsed1.Transition == nil || *parsed1.Transition != "fade" || !reflect.DeepEqual(parsed1.ShapeGroups["grp-1"], []string{"shape-a", "shape-b"}) {
		t.Fatalf("saved meta mismatch: %+v", parsed1)
	}
	if a := parsed1.Animations["shape-a"]; a.Effect != "zoom-in" || a.Order != 1 || a.DurationMs != 500 || a.Trigger != "click" {
		t.Fatalf("saved animations shape-a mismatch: %+v", a)
	}
	if b := parsed1.Animations["shape-b"]; b.Effect != "pulse" || b.Order != 2 || b.DurationMs != 450 || b.Trigger != "with_prev" {
		t.Fatalf("saved animations shape-b mismatch: %+v", b)
	}

	// Content update succeeds with original revision and preserves meta.
	edited1, err := st.UpdateSlidesPage(ctx, g, p1.ID, "封面标题", "正文", "#0f1f3d", nil, nil, p1.Revision)
	if err != nil {
		t.Fatalf("content edit after meta save must not conflict: %v", err)
	}
	if edited1.Revision != p1.Revision+1 || len(edited1.Meta) == 0 {
		t.Fatalf("content edit lost meta: %+v", edited1)
	}

	// Duplicate page preserves meta cleanly (and isolates slice aliasing).
	dup, err := st.DuplicateSlidesPage(ctx, g, deck.ID, edited1.ID, edited1.Revision)
	if err != nil {
		t.Fatalf("duplicate: %v", err)
	}
	var dupMeta store.SlidePageMeta
	if err := json.Unmarshal(dup.Meta, &dupMeta); err != nil {
		t.Fatalf("duplicate meta unmarshal: %v (%s)", err, dup.Meta)
	}
	if dupMeta.TitleStyle == nil || *dupMeta.TitleStyle.FontSize != 48 || dupMeta.Transition == nil || *dupMeta.Transition != "fade" || !reflect.DeepEqual(dupMeta.ShapeGroups["grp-1"], []string{"shape-a", "shape-b"}) || dupMeta.Animations["shape-a"].Effect != "zoom-in" {
		t.Fatalf("duplicate did not preserve meta: %+v", dupMeta)
	}

	// Set a distinct shape group on page 2, then batch-apply theme colors + transition.
	if _, err := op.UpdateSlidesPageMeta(ctx, g, deck.ID, p2.ID, json.RawMessage(`{"shapeGroups":{"grp-p2":["x1","x2"]}}`)); err != nil {
		t.Fatalf("set p2 meta: %v", err)
	}

	// Batch merge theme colors: merges titleStyle/bodyStyle subfields while keeping fontSize/bold/italic, transition, and each page's shapeGroups.
	batched, err := op.BatchUpdateSlidesPagesMeta(ctx, g, deck.ID, json.RawMessage(`{"titleStyle":{"color":"#ffffff"},"bodyStyle":{"color":"#cbd5e1"}}`))
	if err != nil {
		t.Fatalf("batch theme: %v", err)
	}
	if len(batched) != 3 {
		t.Fatalf("batched len=%d want 3", len(batched))
	}
	byID := map[int64]store.SlidesPage{}
	for _, pg := range batched {
		byID[pg.ID] = pg
	}
	var m1, m2 store.SlidePageMeta
	if err := json.Unmarshal(byID[p1.ID].Meta, &m1); err != nil {
		t.Fatalf("p1 batch meta: %v", err)
	}
	if m1.TitleStyle == nil || m1.TitleStyle.FontSize == nil || *m1.TitleStyle.FontSize != 48 || !*m1.TitleStyle.Bold || *m1.TitleStyle.Color != "#ffffff" {
		t.Fatalf("p1 titleStyle merge lost overrides: %+v", m1.TitleStyle)
	}
	if m1.BodyStyle == nil || m1.BodyStyle.Italic == nil || !*m1.BodyStyle.Italic || *m1.BodyStyle.Color != "#cbd5e1" {
		t.Fatalf("p1 bodyStyle merge lost overrides: %+v", m1.BodyStyle)
	}
	if m1.Transition == nil || *m1.Transition != "fade" || !reflect.DeepEqual(m1.ShapeGroups["grp-1"], []string{"shape-a", "shape-b"}) || m1.Animations["shape-a"].Effect != "zoom-in" || m1.Animations["shape-b"].Trigger != "with_prev" {
		t.Fatalf("p1 batch merge lost transition, shapeGroups, or animations: %+v", m1)
	}
	if err := json.Unmarshal(byID[p2.ID].Meta, &m2); err != nil {
		t.Fatalf("p2 batch meta: %v", err)
	}
	if m2.TitleStyle == nil || *m2.TitleStyle.Color != "#ffffff" || !reflect.DeepEqual(m2.ShapeGroups["grp-p2"], []string{"x1", "x2"}) {
		t.Fatalf("p2 batch merge mismatch: %+v", m2)
	}

	// Batch apply transition, then clear transition with "none" while preserving styles & shapeGroups.
	if _, err := op.BatchUpdateSlidesPagesMeta(ctx, g, deck.ID, json.RawMessage(`{"transition":"push"}`)); err != nil {
		t.Fatalf("batch transition push: %v", err)
	}
	listed, err := st.ListSlidesPages(ctx, owner.ID, deck.ID)
	if err != nil || len(listed) != 3 {
		t.Fatalf("list after batch transition: %v", err)
	}
	for _, pg := range listed {
		var pm store.SlidePageMeta
		if err := json.Unmarshal(pg.Meta, &pm); err != nil || pm.Transition == nil || *pm.Transition != "push" {
			t.Fatalf("page %d missing transition push: %s", pg.ID, pg.Meta)
		}
	}
	clearedTrans, err := op.BatchUpdateSlidesPagesMeta(ctx, g, deck.ID, json.RawMessage(`{"transition":"none"}`))
	if err != nil {
		t.Fatalf("batch transition none: %v", err)
	}
	for _, pg := range clearedTrans {
		var pm store.SlidePageMeta
		if err := json.Unmarshal(pg.Meta, &pm); err != nil || pm.Transition != nil {
			t.Fatalf("page %d should have cleared transition: %s", pg.ID, pg.Meta)
		}
		if pm.TitleStyle == nil || *pm.TitleStyle.Color != "#ffffff" {
			t.Fatalf("clearing transition lost titleStyle on page %d: %s", pg.ID, pg.Meta)
		}
	}

	// CopySlidesDeck preserves page meta on all copied pages.
	_, copiedPages, err := st.CopySlidesDeck(ctx, store.SlidesDeckCopy{
		SourceID:    deck.ID,
		UserID:      owner.ID,
		WorkspaceID: ws.ID,
		Title:       "Meta Deck Copy",
		Guard:       &g,
	})
	if err != nil || len(copiedPages) != 3 {
		t.Fatalf("copy deck: len=%d err=%v", len(copiedPages), err)
	}
	var copiedMeta store.SlidePageMeta
	if err := json.Unmarshal(copiedPages[0].Meta, &copiedMeta); err != nil || copiedMeta.TitleStyle == nil || *copiedMeta.TitleStyle.FontSize != 48 || !reflect.DeepEqual(copiedMeta.ShapeGroups["grp-1"], []string{"shape-a", "shape-b"}) || copiedMeta.Animations["shape-a"].Effect != "zoom-in" {
		t.Fatalf("copied deck lost meta: %s (%v)", copiedPages[0].Meta, err)
	}

	// Clearing page meta normalizes back to nil (omitted in JSON).
	clearedPage, err := op.UpdateSlidesPageMeta(ctx, g, deck.ID, p2.ID, json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("clear meta: %v", err)
	}
	if clearedPage.Meta != nil {
		t.Fatalf("cleared meta should be nil, got %s", clearedPage.Meta)
	}

	// Reject invalid meta & batch shapeGroups.
	if _, err := op.UpdateSlidesPageMeta(ctx, g, deck.ID, p1.ID, json.RawMessage(`{"titleStyle":{"color":"not-hex"}}`)); !errors.Is(err, store.ErrInvalidSlideMeta) {
		t.Fatalf("invalid color: %v", err)
	}
	if _, err := op.BatchUpdateSlidesPagesMeta(ctx, g, deck.ID, json.RawMessage(`{"transition":"spin"}`)); !errors.Is(err, store.ErrInvalidSlideMeta) {
		t.Fatalf("invalid batch transition: %v", err)
	}
	if _, err := op.BatchUpdateSlidesPagesMeta(ctx, g, deck.ID, json.RawMessage(`{"shapeGroups":{"g":["a","b"]}}`)); !errors.Is(err, store.ErrInvalidSlideMeta) {
		t.Fatalf("batch shapeGroups should be rejected: %v", err)
	}
	if _, err := op.BatchUpdateSlidesPagesMeta(ctx, g, deck.ID, json.RawMessage(`{"animations":{"s1":{"effect":"fade-in","order":1}}}`)); !errors.Is(err, store.ErrInvalidSlideMeta) {
		t.Fatalf("batch animations should be rejected: %v", err)
	}

	// Viewer cannot edit page meta (ErrForbidden).
	viewer, _, err := st.CreateUser(ctx, "slides-meta-viewer@example.test", "Viewer", "hash")
	if err != nil {
		t.Fatal(err)
	}
	vg := store.RestoreGuard{UserID: viewer.ID, SessionHash: []byte("slides-meta-viewer")}
	if err := st.CreateSession(ctx, vg.SessionHash, viewer.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, deck.ID, viewer.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if _, err := op.UpdateSlidesPageMeta(ctx, vg, deck.ID, p1.ID, json.RawMessage(`{"transition":"fade"}`)); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("viewer update meta: %v", err)
	}
	if _, err := op.BatchUpdateSlidesPagesMeta(ctx, vg, deck.ID, json.RawMessage(`{"transition":"fade"}`)); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("viewer batch meta: %v", err)
	}

	// Revoked session rejected (ErrUnauthenticated).
	if err := st.DeleteSession(ctx, g.SessionHash); err != nil {
		t.Fatal(err)
	}
	if _, err := op.UpdateSlidesPageMeta(ctx, g, deck.ID, p1.ID, json.RawMessage(`{"transition":"fade"}`)); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("revoked update meta: %v", err)
	}
	if _, err := op.BatchUpdateSlidesPagesMeta(ctx, g, deck.ID, json.RawMessage(`{"transition":"fade"}`)); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("revoked batch meta: %v", err)
	}
}

func TestMemorySlidesMeta(t *testing.T)   { exerciseSlidesMeta(t, store.NewMemory()) }
func TestPostgresSlidesMeta(t *testing.T) { exerciseSlidesMeta(t, atomicPostgres(t)) }

func TestSlidesMetaAnimations(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemory()
	owner, ws, err := st.CreateUser(ctx, "slides-anim@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	g := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("slides-anim-sess")}
	if err := st.CreateSession(ctx, g.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	deck, err := st.CreateDriveNode(ctx, g, ws.ID, nil, "slides", "Anim Deck", true)
	if err != nil {
		t.Fatal(err)
	}
	pages, err := st.ListSlidesPages(ctx, owner.ID, deck.ID)
	if err != nil || len(pages) != 1 {
		t.Fatalf("list pages: %v", err)
	}
	p1 := pages[0]
	raw := json.RawMessage(`{"animations":{"s1":{"effect":"fade-in","order":1},"s2":{"effect":"bounce","order":2,"durationMs":600,"trigger":"after_prev"}}}`)
	saved, err := st.UpdateSlidesPageMeta(ctx, g, deck.ID, p1.ID, raw)
	if err != nil {
		t.Fatalf("save animations: %v", err)
	}
	var meta store.SlidePageMeta
	if err := json.Unmarshal(saved.Meta, &meta); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if meta.Animations["s1"].DurationMs != 450 || meta.Animations["s1"].Trigger != "click" {
		t.Fatalf("s1 defaults not normalized: %+v", meta.Animations["s1"])
	}
	if meta.Animations["s2"].Effect != "bounce" || meta.Animations["s2"].DurationMs != 600 || meta.Animations["s2"].Trigger != "after_prev" {
		t.Fatalf("s2 mismatch: %+v", meta.Animations["s2"])
	}
	batched, err := st.BatchUpdateSlidesPagesMeta(ctx, g, deck.ID, json.RawMessage(`{"transition":"fade"}`))
	if err != nil || len(batched) != 1 {
		t.Fatalf("batch update: %v", err)
	}
	var afterBatch store.SlidePageMeta
	if err := json.Unmarshal(batched[0].Meta, &afterBatch); err != nil {
		t.Fatalf("unmarshal after batch: %v", err)
	}
	if afterBatch.Transition == nil || *afterBatch.Transition != "fade" || afterBatch.Animations["s2"].Effect != "bounce" {
		t.Fatalf("batch update lost animations: %+v", afterBatch)
	}
}
