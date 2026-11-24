package api

import (
	"archive/zip"
	"bytes"
	"compress/zlib"
	"encoding/hex"
	"fmt"
	"strings"
	"testing"
	"unicode/utf16"
	"unicode/utf8"
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
