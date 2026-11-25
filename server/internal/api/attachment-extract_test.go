package api

import (
	"archive/zip"
	"bytes"
	"compress/zlib"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/blob"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func buildTestZip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("zip create %s: %v", name, err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatalf("zip write %s: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	return buf.Bytes()
}

func buildTestDOCX(t *testing.T, paragraphs []string) []byte {
	t.Helper()
	var body strings.Builder
	body.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`)
	body.WriteString(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>`)
	for _, p := range paragraphs {
		body.WriteString(`<w:p><w:r><w:t>`)
		body.WriteString(p)
		body.WriteString(`</w:t></w:r></w:p>`)
	}
	body.WriteString(`</w:body></w:document>`)
	return buildTestZip(t, map[string]string{
		"[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`,
		"word/document.xml":   body.String(),
	})
}

func buildTestXLSX(t *testing.T, shared []string, sheetXML string) []byte {
	t.Helper()
	var sst strings.Builder
	sst.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`)
	for _, s := range shared {
		sst.WriteString(`<si><t>`)
		sst.WriteString(s)
		sst.WriteString(`</t></si>`)
	}
	sst.WriteString(`</sst>`)
	return buildTestZip(t, map[string]string{
		"xl/sharedStrings.xml":     sst.String(),
		"xl/worksheets/sheet1.xml": sheetXML,
	})
}

func buildTestPPTX(t *testing.T, slides []string) []byte {
	t.Helper()
	files := map[string]string{
		"ppt/presentation.xml": `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`,
	}
	for i, text := range slides {
		key := fmt.Sprintf("ppt/slides/slide%d.xml", i+1)
		files[key] = fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>%s</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`, text)
	}
	return buildTestZip(t, files)
}

func encodeUTF16BEHex(s string) string {
	u16 := utf16.Encode([]rune(s))
	buf := make([]byte, 2+len(u16)*2)
	buf[0] = 0xFE
	buf[1] = 0xFF
	for i, v := range u16 {
		buf[2+i*2] = byte(v >> 8)
		buf[2+i*2+1] = byte(v)
	}
	return strings.ToUpper(hex.EncodeToString(buf))
}

func buildTestPDF(t *testing.T, contentStream string, flate bool) []byte {
	t.Helper()
	var buf bytes.Buffer
	buf.WriteString("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n")
	if flate {
		var compressed bytes.Buffer
		zw := zlib.NewWriter(&compressed)
		if _, err := zw.Write([]byte(contentStream)); err != nil {
			t.Fatalf("zlib write: %v", err)
		}
		if err := zw.Close(); err != nil {
			t.Fatalf("zlib close: %v", err)
		}
		fmt.Fprintf(&buf, "4 0 obj\n<< /Filter /FlateDecode /Length %d >>\nstream\n", compressed.Len())
		buf.Write(compressed.Bytes())
		buf.WriteString("\nendstream\nendobj\n%%EOF\n")
	} else {
		fmt.Fprintf(&buf, "4 0 obj\n<< /Length %d >>\nstream\n%s\nendstream\nendobj\n%%EOF\n", len(contentStream), contentStream)
	}
	return buf.Bytes()
}

func TestAttachmentExtractFormats(t *testing.T) {
	t.Run("DOCX preserves paragraphs", func(t *testing.T) {
		docx := buildTestDOCX(t, []string{"Enterprise Architecture Spec", "企业级知识库检索架构"})
		text, ext := ExtractAttachmentText("spec.docx", "application/zip", docx)
		if ext != "docx" {
			t.Fatalf("extractor=%q want docx", ext)
		}
		if !strings.Contains(text, "Enterprise Architecture Spec\n企业级知识库检索架构") {
			t.Fatalf("unexpected docx text: %q", text)
		}
	})

	t.Run("XLSX reads shared strings, inline strings, and numbers", func(t *testing.T) {
		sheet := `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="inlineStr"><is><t>预算总额</t></is></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>1</v></c>
      <c r="B2"><v>98765</v></c>
    </row>
  </sheetData>
</worksheet>`
		xlsx := buildTestXLSX(t, []string{"部门名称", "量子计算研发部"}, sheet)
		text, ext := ExtractAttachmentText("budget.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xlsx)
		if ext != "xlsx" {
			t.Fatalf("extractor=%q want xlsx", ext)
		}
		for _, want := range []string{"部门名称", "预算总额", "量子计算研发部", "98765"} {
			if !strings.Contains(text, want) {
				t.Fatalf("xlsx text missing %q: %q", want, text)
			}
		}
	})

	t.Run("PPTX extracts slides in natural numerical order", func(t *testing.T) {
		slides := make([]string, 10)
		for i := range slides {
			slides[i] = fmt.Sprintf("Slide-%d-Content", i+1)
		}
		slides[1] = "第二页：混合向量检索"
		slides[9] = "第十页：总结与路线图"
		pptx := buildTestPPTX(t, slides)
		text, ext := ExtractAttachmentText("deck.pptx", "application/octet-stream", pptx)
		if ext != "pptx" {
			t.Fatalf("extractor=%q want pptx", ext)
		}
		idx2 := strings.Index(text, "第二页：混合向量检索")
		idx10 := strings.Index(text, "第十页：总结与路线图")
		if idx2 < 0 || idx10 < 0 || idx2 >= idx10 {
			t.Fatalf("expected slide 2 before slide 10, got idx2=%d idx10=%d text=%q", idx2, idx10, text)
		}
	})

	t.Run("PDF raw stream with literal escapes, TJ kerning, quote ops, and UTF-16BE hex", func(t *testing.T) {
		zhHex := encodeUTF16BEHex("机密合规手册")
		content := fmt.Sprintf(`
BT
/F1 12 Tf
(Alpha \(v2\) \\ \101) Tj
[(Hybrid) -20 (Search) -260 (Vector)] TJ
(NextLineQuote) '
0 0 (DoubleQuoteLine) "
<%s> Tj
ET
`, zhHex)
		pdf := buildTestPDF(t, content, false)
		text, ext := ExtractAttachmentText("handbook.pdf", "application/pdf", pdf)
		if ext != "pdf" {
			t.Fatalf("extractor=%q want pdf", ext)
		}
		for _, want := range []string{"Alpha (v2) \\ A", "HybridSearch Vector", "NextLineQuote", "DoubleQuoteLine", "机密合规手册"} {
			if !strings.Contains(text, want) {
				t.Fatalf("raw pdf text missing %q: %q", want, text)
			}
		}
	})

	t.Run("PDF FlateDecode zlib compressed stream", func(t *testing.T) {
		zhHex := encodeUTF16BEHex("压缩流私有化架构")
		content := fmt.Sprintf("BT /F1 12 Tf (FlateStreamToken-404) Tj <%s> Tj ET", zhHex)
		pdf := buildTestPDF(t, content, true)
		text, ext := ExtractAttachmentText("compressed.pdf", "application/octet-stream", pdf)
		if ext != "pdf" {
			t.Fatalf("extractor=%q want pdf", ext)
		}
		if !strings.Contains(text, "FlateStreamToken-404") || !strings.Contains(text, "压缩流私有化架构") {
			t.Fatalf("flate pdf extraction failed: %q", text)
		}
	})

	t.Run("Plain text, HTML stripping, and source code", func(t *testing.T) {
		htmlDoc := []byte(`<!doctype html><html><head><style>.a{color:red}</style><script>var secret=1;</script></head><body><h1>产品发布说明</h1><p>支持 &amp; 混合检索</p></body></html>`)
		text, ext := ExtractAttachmentText("release.html", "text/html", htmlDoc)
		if ext != "text" {
			t.Fatalf("html extractor=%q want text", ext)
		}
		if !strings.Contains(text, "产品发布说明") || !strings.Contains(text, "支持 & 混合检索") || strings.Contains(text, "var secret") {
			t.Fatalf("unexpected html text: %q", text)
		}

		goSrc := []byte("package demo\n// ZeroDependencyIndex implements vector lookup\nfunc Run() {}\n")
		srcText, srcExt := ExtractAttachmentText("index.go", "application/octet-stream", goSrc)
		if srcExt != "text" || !strings.Contains(srcText, "ZeroDependencyIndex") {
			t.Fatalf("go source extraction failed: ext=%q text=%q", srcExt, srcText)
		}
	})

	t.Run("Binary image returns empty and huge UTF-8 text truncates cleanly", func(t *testing.T) {
		pngHeader := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 0x00, 0x00, 0x00, 0x0d}
		if text, ext := ExtractAttachmentText("photo.png", "image/png", pngHeader); text != "" || ext != "" {
			t.Fatalf("binary png should not extract text: ext=%q text=%q", ext, text)
		}

		// Build > 300 KiB of 3-byte CJK runes to verify UTF-8 safe 256 KiB cap.
		huge := []byte(strings.Repeat("知识库检索向量", 20000))
		text, ext := ExtractAttachmentText("huge.txt", "text/plain", huge)
		if ext != "text" {
			t.Fatalf("huge.txt extractor=%q want text", ext)
		}
		if len(text) > maxExtractedAttachmentBytes || len(text) < maxExtractedAttachmentBytes-16 {
			t.Fatalf("unexpected truncated length: %d (cap %d)", len(text), maxExtractedAttachmentBytes)
		}
		if !utf8.ValidString(text) {
			t.Fatal("truncated extracted text is not valid UTF-8")
		}
	})
}

func TestOCRConnectorHTTPAndOpenAIAndFallback(t *testing.T) {
	pngBytes := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 0x00, 0x00, 0x00, 0x0d, 'I', 'H', 'D', 'R'}
	scannedPDF := []byte("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n4 0 obj\n<< /Filter /DCTDecode /Length 4 >>\nstream\n\xff\xd8\xff\xd9\nendstream\nendobj\n%%EOF\n")

	t.Run("unconfigured OCR is a clean no-op", func(t *testing.T) {
		t.Setenv("JIANGE_OCR_URL", "")
		t.Setenv("JIANGE_OCR_MODE", "")
		t.Setenv("JIANGE_OCR_API_KEY", "")
		t.Setenv("JIANGE_OCR_TESSERACT", "")

		if text, ext := ExtractAttachmentTextWithContext(context.Background(), "scan.png", "image/png", pngBytes); text != "" || ext != "" {
			t.Fatalf("unconfigured image OCR = (%q, %q), want empty", text, ext)
		}
		if text, ext := ExtractAttachmentTextWithContext(context.Background(), "scanned.pdf", "application/pdf", scannedPDF); text != "" || ext != "pdf" {
			t.Fatalf("unconfigured scanned PDF OCR = (%q, %q), want (\"\", \"pdf\")", text, ext)
		}
	})

	t.Run("generic HTTP OCR extracts text from PNG and scanned PDF without invoking OCR on text PDF", func(t *testing.T) {
		var calls atomic.Int32
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			if got := r.Header.Get("Authorization"); got != "Bearer ocr-secret-token" {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			var req struct {
				Filename   string `json:"filename"`
				MIME       string `json:"mime"`
				DataBase64 string `json:"dataBase64"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			decoded, err := base64.StdEncoding.DecodeString(req.DataBase64)
			if err != nil || len(decoded) == 0 {
				http.Error(w, "invalid base64", http.StatusBadRequest)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			if req.MIME == "application/pdf" {
				_ = json.NewEncoder(w).Encode(map[string]string{"text": "扫描件合同编号：JG-2026-8899"})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"text": "白板架构图：混合检索 + OCR 引擎"})
		}))
		defer srv.Close()

		t.Setenv("JIANGE_OCR_URL", srv.URL+"/ocr")
		t.Setenv("JIANGE_OCR_API_KEY", "ocr-secret-token")
		t.Setenv("JIANGE_OCR_MODE", "")
		t.Setenv("JIANGE_OCR_TESSERACT", "")

		imgText, imgExt := ExtractAttachmentTextWithContext(context.Background(), "whiteboard.png", "image/png", pngBytes)
		if imgExt != "ocr" || !strings.Contains(imgText, "白板架构图：混合检索 + OCR 引擎") {
			t.Fatalf("PNG OCR = (%q, %q)", imgText, imgExt)
		}

		pdfText, pdfExt := ExtractAttachmentTextWithContext(context.Background(), "scanned-contract.pdf", "application/pdf", scannedPDF)
		if pdfExt != "pdf+ocr" || !strings.Contains(pdfText, "JG-2026-8899") {
			t.Fatalf("scanned PDF OCR = (%q, %q)", pdfText, pdfExt)
		}

		// Standard PDF with extractable text must NOT trigger OCR.
		before := calls.Load()
		normalPDF := buildTestPDF(t, "BT /F1 12 Tf (DirectPDFTextOnly) Tj ET", false)
		normalText, normalExt := ExtractAttachmentTextWithContext(context.Background(), "normal.pdf", "application/pdf", normalPDF)
		if normalExt != "pdf" || !strings.Contains(normalText, "DirectPDFTextOnly") {
			t.Fatalf("normal PDF = (%q, %q)", normalText, normalExt)
		}
		if calls.Load() != before {
			t.Fatalf("OCR was unexpectedly invoked for text-bearing PDF")
		}
	})

	t.Run("OpenAI Vision OCR mode parses choices[0].message.content", func(t *testing.T) {
		var receivedModel string
		var receivedImageURL string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if got := r.Header.Get("Authorization"); got != "Bearer sk-vision-test" {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			var payload struct {
				Model    string `json:"model"`
				Messages []struct {
					Role    string `json:"role"`
					Content []struct {
						Type     string `json:"type"`
						Text     string `json:"text"`
						ImageURL *struct {
							URL string `json:"url"`
						} `json:"image_url"`
					} `json:"content"`
				} `json:"messages"`
			}
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			receivedModel = payload.Model
			for _, m := range payload.Messages {
				for _, part := range m.Content {
					if part.Type == "image_url" && part.ImageURL != nil {
						receivedImageURL = part.ImageURL.URL
					}
				}
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"choices": []map[string]any{
					{
						"message": map[string]any{
							"role":    "assistant",
							"content": "发票金额：¥12,800.00\n项目：企业私有化部署",
						},
					},
				},
			})
		}))
		defer srv.Close()

		t.Setenv("JIANGE_OCR_URL", srv.URL+"/v1/chat/completions")
		t.Setenv("JIANGE_OCR_MODE", "openai")
		t.Setenv("JIANGE_OCR_API_KEY", "sk-vision-test")
		t.Setenv("JIANGE_OCR_MODEL", "gpt-4.1-mini")
		t.Setenv("JIANGE_OCR_TESSERACT", "")

		text, ext := ExtractAttachmentTextWithContext(context.Background(), "invoice.jpg", "image/jpeg", []byte{0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10})
		if ext != "ocr" {
			t.Fatalf("extractor = %q, want ocr", ext)
		}
		if !strings.Contains(text, "发票金额：¥12,800.00") || !strings.Contains(text, "企业私有化部署") {
			t.Fatalf("unexpected OpenAI OCR text: %q", text)
		}
		if receivedModel != "gpt-4.1-mini" {
			t.Fatalf("model = %q, want gpt-4.1-mini", receivedModel)
		}
		if !strings.HasPrefix(receivedImageURL, "data:image/jpeg;base64,") {
			t.Fatalf("unexpected image_url prefix: %q", receivedImageURL)
		}
	})
}

func TestReindexAttachmentsBackfill(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemory()
	blobs := blob.NewMemory()

	// Mock OCR so PNG attachment gets indexed during backfill.
	ocrSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"text": "Backfill OCR Receipt 90210"})
	}))
	defer ocrSrv.Close()
	t.Setenv("JIANGE_OCR_URL", ocrSrv.URL)
	t.Setenv("JIANGE_OCR_MODE", "")
	t.Setenv("JIANGE_OCR_TESSERACT", "")

	u1, ws1, err := st.CreateUser(ctx, "reindex1@example.test", "Reindex One", "hash")
	if err != nil {
		t.Fatal(err)
	}
	u2, ws2, err := st.CreateUser(ctx, "reindex2@example.test", "Reindex Two", "hash")
	if err != nil {
		t.Fatal(err)
	}
	doc1, err := st.CreateDoc(ctx, ws1.ID, u1.ID, nil, "WS1 Doc", nil)
	if err != nil {
		t.Fatal(err)
	}
	doc2, err := st.CreateDoc(ctx, ws2.ID, u2.ID, nil, "WS2 Doc", nil)
	if err != nil {
		t.Fatal(err)
	}

	docxBytes := buildTestDOCX(t, []string{"Quarterly Backfill Spec", "历史附件全文回溯"})
	pngBytes := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 0x00, 0x00, 0x00, 0x0d}
	binBytes := []byte{0x00, 0x01, 0x02, 0x03, 0x04}

	_ = blobs.Put(ctx, "k/docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", docxBytes)
	_ = blobs.Put(ctx, "k/png", "image/png", pngBytes)
	_ = blobs.Put(ctx, "k/bin", "application/octet-stream", binBytes)
	_ = blobs.Put(ctx, "k/ws2", "text/plain", []byte("Workspace Two Plain Note"))

	if _, err := st.CreateFile(ctx, store.FileMeta{DocID: doc1.ID, UploaderID: u1.ID, Name: "spec.docx", Mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", Size: int64(len(docxBytes)), ObjectKey: "k/docx"}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateFile(ctx, store.FileMeta{DocID: doc1.ID, UploaderID: u1.ID, Name: "receipt.png", Mime: "image/png", Size: int64(len(pngBytes)), ObjectKey: "k/png"}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateFile(ctx, store.FileMeta{DocID: doc1.ID, UploaderID: u1.ID, Name: "raw.bin", Mime: "application/octet-stream", Size: int64(len(binBytes)), ObjectKey: "k/bin"}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateFile(ctx, store.FileMeta{DocID: doc1.ID, UploaderID: u1.ID, Name: "missing.txt", Mime: "text/plain", Size: 12, ObjectKey: "k/does-not-exist"}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateFile(ctx, store.FileMeta{DocID: doc2.ID, UploaderID: u2.ID, Name: "ws2.txt", Mime: "text/plain", Size: 24, ObjectKey: "k/ws2"}); err != nil {
		t.Fatal(err)
	}

	// Scoped to ws1: 4 scanned -> 2 indexed (docx + png), 1 skipped (raw.bin), 1 failed (missing blob).
	ws1Stats, err := ReindexAttachments(ctx, st, blobs, ws1.ID)
	if err != nil {
		t.Fatalf("ReindexAttachments ws1: %v", err)
	}
	if ws1Stats.WorkspaceID != ws1.ID || ws1Stats.Scanned != 4 || ws1Stats.Indexed != 2 || ws1Stats.Skipped != 1 || ws1Stats.Failed != 1 {
		t.Fatalf("ws1Stats = %+v, want scanned=4 indexed=2 skipped=1 failed=1", ws1Stats)
	}

	hits, err := st.SearchAttachmentDocIDs(ctx, []int64{doc1.ID, doc2.ID}, "90210")
	if err != nil || !hits[doc1.ID] || hits[doc2.ID] {
		t.Fatalf("expected OCR receipt indexed in doc1 only: hits=%v err=%v", hits, err)
	}
	hits2, err := st.SearchAttachmentDocIDs(ctx, []int64{doc1.ID, doc2.ID}, "Workspace Two Plain Note")
	if err != nil || len(hits2) != 0 {
		t.Fatalf("ws2 should not be indexed yet: hits=%v err=%v", hits2, err)
	}

	// Global backfill (wsID == 0) indexes ws2 too.
	allStats, err := ReindexAttachments(ctx, st, blobs, 0)
	if err != nil {
		t.Fatalf("ReindexAttachments all: %v", err)
	}
	if allStats.Scanned != 5 || allStats.Indexed != 3 || allStats.Skipped != 1 || allStats.Failed != 1 {
		t.Fatalf("allStats = %+v, want scanned=5 indexed=3 skipped=1 failed=1", allStats)
	}
	hits3, err := st.SearchAttachmentDocIDs(ctx, []int64{doc1.ID, doc2.ID}, "Workspace Two Plain Note")
	if err != nil || !hits3[doc2.ID] {
		t.Fatalf("ws2 should be indexed after global backfill: hits=%v err=%v", hits3, err)
	}
}
