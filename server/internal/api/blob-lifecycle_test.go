package api

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/blob"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// P0.6：附件删除按对象键引用计数（副本共享 blob），最后一个引用才删对象；
// 重复删除 404。
func TestFileDeleteReferenceCounting(t *testing.T) {
	st := store.NewMemory()
	blobs := blob.NewMemory()
	srv := &Server{Store: st, Blobs: blobs, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	jar, _ := cookiejar.New(nil)
	c := &http.Client{Jar: jar}
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "blob@x.com", "name": "B", "password": "password123"})

	var doc struct{ ID int64 }
	json.NewDecoder(post(t, c, ts.URL+"/api/docs", map[string]string{"title": "附件"}).Body).Decode(&doc)

	upload := func(name string) (id int64, key string) {
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		fw, _ := mw.CreateFormFile("file", name)
		_, _ = fw.Write([]byte("payload-" + name))
		_ = mw.Close()
		req, _ := http.NewRequest("POST", ts.URL+"/api/docs/"+strconv.FormatInt(doc.ID, 10)+"/files", &buf)
		req.Header.Set("Content-Type", mw.FormDataContentType())
		req.Header.Set("X-Jiange-Upload", "1")
		res, err := c.Do(req)
		if err != nil || res.StatusCode != 201 {
			t.Fatalf("upload %s: %v %d", name, err, res.StatusCode)
		}
		var fm store.FileMeta
		json.NewDecoder(res.Body).Decode(&fm)
		full, err := st.GetFile(nil, fm.ID) // ObjectKey 从不离开服务端
		if err != nil {
			t.Fatal(err)
		}
		return fm.ID, full.ObjectKey
	}
	del := func(id int64) int {
		req, _ := http.NewRequest("DELETE", ts.URL+"/api/files/"+strconv.FormatInt(id, 10), nil)
		res, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return res.StatusCode
	}

	id1, key := upload("a.png")
	// 同键第二个引用（文档复制共享对象的形态）
	f2, err := st.CreateFile(nil, store.FileMeta{DocID: doc.ID, UploaderID: 1, Name: "copy", Mime: "image/png", Size: 7, ObjectKey: key})
	if err != nil {
		t.Fatal(err)
	}

	// 删除第一个引用：对象仍在
	if code := del(id1); code != 204 {
		t.Fatalf("delete first: %d", code)
	}
	if _, err := blobs.Get(nil, key); err != nil {
		t.Fatalf("blob died with a remaining reference: %v", err)
	}

	// 删除最后一个引用：对象回收
	if code := del(f2.ID); code != 204 {
		t.Fatalf("delete last: %d", code)
	}
	if _, err := blobs.Get(nil, key); err != blob.ErrNotFound {
		t.Fatalf("blob outlived its last reference: %v", err)
	}

	// 幂等：重复删除 → 404
	if code := del(id1); code != 404 {
		t.Fatalf("redelete: %d", code)
	}
}
