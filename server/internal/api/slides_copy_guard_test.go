package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

// Adds an image after API blob verification, reproducing another editor's
// change before the copy transaction begins.
type slidesImageAddedDuringCopy struct {
	store.Store
	fileID int64
}

func (s slidesImageAddedDuringCopy) CopySlidesDeck(ctx context.Context, c store.SlidesDeckCopy) (store.DocMeta, []store.SlidesPage, error) {
	pages, err := s.Store.ListSlidesPages(ctx, c.UserID, c.SourceID)
	if err != nil {
		return store.DocMeta{}, nil, err
	}
	shapes := json.RawMessage(fmt.Sprintf(`[{"id":"img","kind":"image","x":10,"y":10,"width":30,"height":30,"color":"#ffffff","fileId":%d}]`, s.fileID))
	_, err = s.Store.UpdateSlidesPage(ctx, *c.Guard, pages[0].ID, pages[0].Title, pages[0].Body, pages[0].Background, nil, &shapes, pages[0].Revision)
	if err != nil {
		return store.DocMeta{}, nil, err
	}
	return s.Store.CopySlidesDeck(ctx, c)
}

func TestSlidesCopyRejectsImageAddedAfterVerification(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemory()
	// The server is set up with a wrapper after a fixture attachment exists.
	var wrapper slidesImageAddedDuringCopy
	wrapper.Store = st
	ts, owner := newTestServer(t, &wrapper, nil)
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "copy-image-race@test.dev", "name": "Owner", "password": "password123"})
	var d store.DriveEntry
	res := post(t, owner, ts.URL+"/api/drive/nodes", map[string]any{"kind": "slides", "title": "Source"})
	if err := json.NewDecoder(res.Body).Decode(&d); err != nil || res.StatusCode != http.StatusCreated {
		t.Fatalf("deck: %d %v", res.StatusCode, err)
	}
	file, err := st.CreateFile(ctx, store.FileMeta{DocID: d.ID, Name: "missing.png", Mime: "image/png", ObjectKey: "missing", Size: 1})
	if err != nil {
		t.Fatal(err)
	}
	wrapper.fileID = file.ID
	res = post(t, owner, ts.URL+"/api/docs/"+strconv64(d.ID)+"/duplicate", nil)
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("unverified image copied: %d", res.StatusCode)
	}
	var children struct{ Entries []store.DriveEntry }
	res = cGet(t, owner, ts.URL+"/api/drive/children")
	if err = json.NewDecoder(res.Body).Decode(&children); err != nil || len(children.Entries) != 1 || children.Entries[0].ID != d.ID {
		t.Fatalf("partial copy created: %+v %v", children.Entries, err)
	}
}
