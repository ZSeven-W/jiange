package api

import (
	"archive/zip"
	"bytes"
	"compress/zlib"
	"context"
	"encoding/binary"
	"encoding/xml"
	"html"
	"io"
	"mime"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

const (
	maxExtractedAttachmentBytes = 256 << 10 // 256 KiB UTF-8 safe cap
	maxAttachmentZipEntryBytes  = 16 << 20  // 16 MiB per zip entry safety cap
	maxAttachmentPDFStreamBytes = 8 << 20   // 8 MiB per inflated PDF stream safety cap
)

var (
	reHTMLScript  = regexp.MustCompile(`(?is)<script\b[^>]*>.*?</script>`)
	reHTMLStyle   = regexp.MustCompile(`(?is)<style\b[^>]*>.*?</style>`)
	reHTMLComment = regexp.MustCompile(`(?s)<!--.*?-->`)
	reHTMLBlock   = regexp.MustCompile(`(?i)</?(?:p|div|br|li|tr|td|th|h[1-6]|section|article|blockquote|pre|header|footer|hr)\b[^>]*>`)
	reHTMLTag     = regexp.MustCompile(`<[^>]+>`)
	reNaturalNum  = regexp.MustCompile(`\d+`)
)

// ExtractAttachmentText extracts searchable full text from common office, PDF,
// and plain-text / source-code attachments using pure Go stdlib only.
// Extracted text is normalized and capped cleanly at 256 KiB on a UTF-8 rune boundary.
func ExtractAttachmentText(filename, mimeType string, data []byte) (string, string) {
	if len(data) == 0 {
		return "", ""
	}
	ext := strings.ToLower(filepath.Ext(strings.TrimSpace(filename)))
	mediaType := ""
	if mt, _, err := mime.ParseMediaType(strings.TrimSpace(mimeType)); err == nil {
		mediaType = strings.ToLower(mt)
	} else {
		mediaType = strings.ToLower(strings.TrimSpace(mimeType))
	}

	switch {
	case ext == ".docx" || strings.Contains(mediaType, "wordprocessingml"):
		if text := extractDOCXText(data); text != "" {
			return finalizeExtractedText(text), "docx"
		}
		return "", "docx"

	case ext == ".xlsx" || strings.Contains(mediaType, "spreadsheetml"):
		if text := extractXLSXText(data); text != "" {
			return finalizeExtractedText(text), "xlsx"
		}
		return "", "xlsx"

	case ext == ".pptx" || strings.Contains(mediaType, "presentationml"):
		if text := extractPPTXText(data); text != "" {
			return finalizeExtractedText(text), "pptx"
		}
		return "", "pptx"

	case ext == ".pdf" || mediaType == "application/pdf" || bytes.HasPrefix(bytes.TrimLeft(data, " \t\r\n"), []byte("%PDF-")):
		if text := extractPDFText(data); text != "" {
			return finalizeExtractedText(text), "pdf"
		}
		return "", "pdf"
	}

	// Sniff OOXML zip archives even when filename/MIME is generic (e.g. application/zip).
	if len(data) >= 4 && data[0] == 'P' && data[1] == 'K' && data[2] == 3 && data[3] == 4 {
		if kind := sniffOOXMLKind(data); kind != "" {
			switch kind {
			case "docx":
				return finalizeExtractedText(extractDOCXText(data)), "docx"
			case "xlsx":
				return finalizeExtractedText(extractXLSXText(data)), "xlsx"
			case "pptx":
				return finalizeExtractedText(extractPPTXText(data)), "pptx"
			}
		}
	}

	if isPlainTextAttachment(ext, mediaType) {
		isHTML := ext == ".html" || ext == ".htm" || mediaType == "text/html"
		if text := extractPlainText(data, isHTML); text != "" {
			return finalizeExtractedText(text), "text"
		}
		return "", "text"
	}

	return "", ""
}

// indexAttachmentText extracts full text from an uploaded attachment and
// persists it in AttachmentTextStore (best-effort; never fails the upload).
func (s *Server) indexAttachmentText(ctx context.Context, att store.FileMeta, wsID int64, data []byte) {
	if s == nil || s.Store == nil || att.ID <= 0 || att.DocID <= 0 || len(data) == 0 {
		return
	}
	ats, ok := s.Store.(store.AttachmentTextStore)
	if !ok {
		return
	}
	text, extractor := ExtractAttachmentText(att.Name, att.Mime, data)
	if strings.TrimSpace(text) == "" {
		return
	}
	err := ats.UpsertAttachmentText(ctx, store.AttachmentTextEntry{
		AttachmentID:  att.ID,
		DocID:         att.DocID,
		WorkspaceID:   wsID,
		Filename:      att.Name,
		Mime:          att.Mime,
		ExtractedText: text,
		Extractor:     extractor,
	})
	if err != nil && s.Log != nil {
		s.Log.Warn("attachment text index upsert failed", "attachmentId", att.ID, "docId", att.DocID, "err", err)
	}
}

func isPlainTextAttachment(ext, mediaType string) bool {
	switch ext {
	case ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".yaml", ".yml",
		".html", ".htm", ".xml", ".go", ".ts", ".tsx", ".js", ".jsx", ".mjs",
		".cjs", ".py", ".sql", ".css", ".scss", ".less", ".sh", ".bash", ".zsh",
		".toml", ".ini", ".cfg", ".conf", ".log", ".java", ".rs", ".c", ".h",
		".cpp", ".hpp", ".rb", ".php", ".swift", ".kt", ".vue", ".svelte":
		return true
	}
	if strings.HasPrefix(mediaType, "text/") {
		return true
	}
	switch mediaType {
	case "application/json", "application/xml", "application/javascript",
		"application/x-javascript", "application/x-yaml", "application/yaml",
		"application/sql", "application/csv":
		return true
	}
	return false
}

func finalizeExtractedText(raw string) string {
	if raw == "" {
		return ""
	}
	raw = strings.ReplaceAll(raw, "\x00", "")
	raw = strings.ReplaceAll(raw, "\r\n", "\n")
	raw = strings.ReplaceAll(raw, "\r", "\n")

	lines := strings.Split(raw, "\n")
	var out strings.Builder
	out.Grow(min(len(raw), maxExtractedAttachmentBytes))
	for _, line := range lines {
		clean := strings.Join(strings.Fields(line), " ")
		if clean == "" {
			continue
		}
		if out.Len() > 0 {
			out.WriteByte('\n')
		}
		out.WriteString(clean)
		if out.Len() >= maxExtractedAttachmentBytes {
			break
		}
	}
	return truncateAttachmentUTF8(out.String(), maxExtractedAttachmentBytes)
}

func truncateAttachmentUTF8(s string, maxBytes int) string {
	if maxBytes <= 0 || len(s) <= maxBytes {
		return s
	}
	// Walk backward from maxBytes to the start of a valid UTF-8 rune.
	cut := maxBytes
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	// Also ensure the preceding rune isn't truncated.
	for cut > 0 && !utf8.ValidString(s[:cut]) {
		cut--
	}
	return s[:cut]
}

func extractPlainText(data []byte, isHTML bool) string {
	var text string
	switch {
	case len(data) >= 2 && data[0] == 0xFE && data[1] == 0xFF:
		text = decodeUTF16(data[2:], binary.BigEndian)
	case len(data) >= 2 && data[0] == 0xFF && data[1] == 0xFE:
		text = decodeUTF16(data[2:], binary.LittleEndian)
	default:
		checkLen := min(len(data), 4096)
		if bytes.IndexByte(data[:checkLen], 0) >= 0 {
			return ""
		}
		trimmed := bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})
		if len(trimmed) > maxExtractedAttachmentBytes*2 {
			trimmed = trimmed[:maxExtractedAttachmentBytes*2]
		}
		text = string(trimmed)
	}
	if isHTML {
		text = reHTMLScript.ReplaceAllString(text, " ")
		text = reHTMLStyle.ReplaceAllString(text, " ")
		text = reHTMLComment.ReplaceAllString(text, " ")
		text = reHTMLBlock.ReplaceAllString(text, "\n")
		text = reHTMLTag.ReplaceAllString(text, " ")
		text = html.UnescapeString(text)
	}
	return text
}

func decodeUTF16(b []byte, order binary.ByteOrder) string {
	if len(b) < 2 {
		return ""
	}
	n := len(b) / 2
	u16 := make([]uint16, n)
	for i := 0; i < n; i++ {
		u16[i] = order.Uint16(b[i*2 : i*2+2])
	}
	return string(utf16.Decode(u16))
}

func sniffOOXMLKind(data []byte) string {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return ""
	}
	for _, f := range zr.File {
		name := strings.ToLower(f.Name)
		switch {
		case name == "word/document.xml":
			return "docx"
		case name == "xl/workbook.xml" || name == "xl/sharedstrings.xml" || strings.HasPrefix(name, "xl/worksheets/sheet"):
			return "xlsx"
		case name == "ppt/presentation.xml" || strings.HasPrefix(name, "ppt/slides/slide"):
			return "pptx"
		}
	}
	return ""
}

func naturalLess(a, b string) bool {
	na := reNaturalNum.FindString(a)
	nb := reNaturalNum.FindString(b)
	if na != "" && nb != "" {
		ia, ea := strconv.Atoi(na)
		ib, eb := strconv.Atoi(nb)
		if ea == nil && eb == nil && ia != ib {
			return ia < ib
		}
	}
	return a < b
}

// --- DOCX ---

func extractDOCXText(data []byte) string {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return ""
	}
	var primary *zip.File
	var extras []*zip.File
	for _, f := range zr.File {
		lower := strings.ToLower(f.Name)
		if lower == "word/document.xml" {
			primary = f
		} else if strings.HasPrefix(lower, "word/header") ||
			strings.HasPrefix(lower, "word/footer") ||
			lower == "word/footnotes.xml" ||
			lower == "word/endnotes.xml" {
			if strings.HasSuffix(lower, ".xml") {
				extras = append(extras, f)
			}
		}
	}
	sort.Slice(extras, func(i, j int) bool { return naturalLess(extras[i].Name, extras[j].Name) })

	files := make([]*zip.File, 0, 1+len(extras))
	if primary != nil {
		files = append(files, primary)
	}
	files = append(files, extras...)

	var out strings.Builder
	for _, f := range files {
		if out.Len() >= maxExtractedAttachmentBytes {
			break
		}
		part := parseWordXMLParagraphs(f)
		if part != "" {
			if out.Len() > 0 {
				out.WriteByte('\n')
			}
			out.WriteString(part)
		}
	}
	return out.String()
}

func parseWordXMLParagraphs(f *zip.File) string {
	rc, err := f.Open()
	if err != nil {
		return ""
	}
	defer rc.Close()

	dec := xml.NewDecoder(io.LimitReader(rc, maxAttachmentZipEntryBytes))
	var out, para strings.Builder
	inText := false
	flushPara := func() {
		if para.Len() == 0 {
			return
		}
		if out.Len() > 0 {
			out.WriteByte('\n')
		}
		out.WriteString(para.String())
		para.Reset()
	}

	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "p":
				flushPara()
			case "t":
				inText = true
			case "tab":
				para.WriteByte('\t')
			case "br", "cr":
				para.WriteByte('\n')
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "t":
				inText = false
			case "p":
				flushPara()
			}
		case xml.CharData:
			if inText {
				para.Write(t)
			}
		}
		if out.Len() >= maxExtractedAttachmentBytes {
			break
		}
	}
	flushPara()
	return out.String()
}

// --- XLSX ---

func extractXLSXText(data []byte) string {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return ""
	}
	var sharedFile *zip.File
	var sheets []*zip.File
	for _, f := range zr.File {
		lower := strings.ToLower(f.Name)
		if lower == "xl/sharedstrings.xml" {
			sharedFile = f
		} else if strings.HasPrefix(lower, "xl/worksheets/sheet") && strings.HasSuffix(lower, ".xml") {
			sheets = append(sheets, f)
		}
	}
	sort.Slice(sheets, func(i, j int) bool { return naturalLess(sheets[i].Name, sheets[j].Name) })

	var shared []string
	if sharedFile != nil {
		shared = parseXLSXSharedStrings(sharedFile)
	}

	var out strings.Builder
	for _, sheet := range sheets {
		if out.Len() >= maxExtractedAttachmentBytes {
			break
		}
		part := parseXLSXWorksheet(sheet, shared)
		if part != "" {
			if out.Len() > 0 {
				out.WriteByte('\n')
			}
			out.WriteString(part)
		}
	}
	if out.Len() == 0 && len(shared) > 0 {
		return strings.Join(shared, "\n")
	}
	return out.String()
}

func parseXLSXSharedStrings(f *zip.File) []string {
	rc, err := f.Open()
	if err != nil {
		return nil
	}
	defer rc.Close()

	dec := xml.NewDecoder(io.LimitReader(rc, maxAttachmentZipEntryBytes))
	var items []string
	var cur strings.Builder
	inSI, inT, inPhonetic := false, false, false
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "si":
				inSI = true
				cur.Reset()
			case "rPh":
				inPhonetic = true
			case "t":
				if inSI && !inPhonetic {
					inT = true
				}
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "t":
				inT = false
			case "rPh":
				inPhonetic = false
			case "si":
				items = append(items, cur.String())
				inSI = false
			}
		case xml.CharData:
			if inSI && inT && !inPhonetic {
				cur.Write(t)
			}
		}
	}
	return items
}

func parseXLSXWorksheet(f *zip.File, shared []string) string {
	rc, err := f.Open()
	if err != nil {
		return ""
	}
	defer rc.Close()

	dec := xml.NewDecoder(io.LimitReader(rc, maxAttachmentZipEntryBytes))
	var out, valBuf, inlineBuf strings.Builder
	var rowCells []string
	inCell, inVal, inInline, inT := false, false, false, false
	cellType := ""

	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "row":
				rowCells = rowCells[:0]
			case "c":
				inCell = true
				cellType = ""
				valBuf.Reset()
				inlineBuf.Reset()
				for _, attr := range t.Attr {
					if attr.Name.Local == "t" {
						cellType = attr.Value
						break
					}
				}
			case "v":
				if inCell {
					inVal = true
				}
			case "is":
				if inCell {
					inInline = true
				}
			case "t":
				if inInline {
					inT = true
				}
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "v":
				inVal = false
			case "t":
				inT = false
			case "is":
				inInline = false
			case "c":
				if inCell {
					var val string
					switch cellType {
					case "s":
						if idx, convErr := strconv.Atoi(strings.TrimSpace(valBuf.String())); convErr == nil && idx >= 0 && idx < len(shared) {
							val = shared[idx]
						}
					case "inlineStr":
						val = inlineBuf.String()
					case "b":
						if strings.TrimSpace(valBuf.String()) == "1" {
							val = "TRUE"
						} else if strings.TrimSpace(valBuf.String()) == "0" {
							val = "FALSE"
						}
					default:
						val = valBuf.String()
					}
					val = strings.TrimSpace(val)
					if val != "" {
						rowCells = append(rowCells, val)
					}
					inCell = false
				}
			case "row":
				if len(rowCells) > 0 {
					if out.Len() > 0 {
						out.WriteByte('\n')
					}
					out.WriteString(strings.Join(rowCells, " "))
				}
				rowCells = rowCells[:0]
			}
		case xml.CharData:
			if inVal {
				valBuf.Write(t)
			} else if inInline && inT {
				inlineBuf.Write(t)
			}
		}
		if out.Len() >= maxExtractedAttachmentBytes {
			break
		}
	}
	return out.String()
}

// --- PPTX ---

func extractPPTXText(data []byte) string {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return ""
	}
	var slides, notes []*zip.File
	for _, f := range zr.File {
		lower := strings.ToLower(f.Name)
		if strings.HasPrefix(lower, "ppt/slides/slide") && strings.HasSuffix(lower, ".xml") {
			slides = append(slides, f)
		} else if strings.HasPrefix(lower, "ppt/notesslides/notesslide") && strings.HasSuffix(lower, ".xml") {
			notes = append(notes, f)
		}
	}
	sort.Slice(slides, func(i, j int) bool { return naturalLess(slides[i].Name, slides[j].Name) })
	sort.Slice(notes, func(i, j int) bool { return naturalLess(notes[i].Name, notes[j].Name) })

	var out strings.Builder
	for _, f := range append(slides, notes...) {
		if out.Len() >= maxExtractedAttachmentBytes {
			break
		}
		part := parseWordXMLParagraphs(f) // DrawingML also uses <a:p>, <a:t>, <a:br>
		if part != "" {
			if out.Len() > 0 {
				out.WriteByte('\n')
			}
			out.WriteString(part)
		}
	}
	return out.String()
}

// --- PDF ---

func extractPDFText(data []byte) string {
	var out strings.Builder
	streamCount := 0
	pos := 0
	for pos < len(data) && out.Len() < maxExtractedAttachmentBytes {
		idx := bytes.Index(data[pos:], []byte("stream"))
		if idx < 0 {
			break
		}
		kwPos := pos + idx
		// Guard against matching "endstream" or identifiers containing "stream".
		if kwPos > 0 && !isPDFDelimiterOrSpace(data[kwPos-1]) {
			pos = kwPos + len("stream")
			continue
		}
		bodyStart := kwPos + len("stream")
		if bodyStart >= len(data) {
			break
		}
		if data[bodyStart] == '\r' && bodyStart+1 < len(data) && data[bodyStart+1] == '\n' {
			bodyStart += 2
		} else if data[bodyStart] == '\n' {
			bodyStart++
		} else if data[bodyStart] == '\r' {
			bodyStart++
		} else {
			pos = bodyStart
			continue
		}

		dictStart := max(0, kwPos-2048)
		dictSlice := data[dictStart:kwPos]

		endRel := bytes.Index(data[bodyStart:], []byte("endstream"))
		if endRel < 0 {
			break
		}
		streamEnd := bodyStart + endRel
		pos = streamEnd + len("endstream")
		streamCount++

		// Trim optional EOL preceding endstream.
		trimmedEnd := streamEnd
		if trimmedEnd > bodyStart && data[trimmedEnd-1] == '\n' {
			trimmedEnd--
			if trimmedEnd > bodyStart && data[trimmedEnd-1] == '\r' {
				trimmedEnd--
			}
		} else if trimmedEnd > bodyStart && data[trimmedEnd-1] == '\r' {
			trimmedEnd--
		}
		rawStream := data[bodyStart:trimmedEnd]
		if len(rawStream) == 0 {
			continue
		}

		// Skip binary image streams (JPEG, JPEG2000, CCITT, JBIG2).
		if hasPDFImageFilter(dictSlice) {
			continue
		}

		content := rawStream
		if hasPDFFlateFilter(dictSlice) {
			if inflated, ok := inflatePDFStream(rawStream); ok {
				content = inflated
			} else {
				continue
			}
		}

		if text := parsePDFContentStream(content); text != "" {
			if out.Len() > 0 {
				out.WriteByte('\n')
			}
			out.WriteString(text)
		}
	}

	// Fallback for synthetic minimal PDFs with inline BT..ET outside stream wrappers.
	if streamCount == 0 && bytes.Contains(data, []byte("BT")) && bytes.Contains(data, []byte("ET")) {
		if text := parsePDFContentStream(data); text != "" {
			out.WriteString(text)
		}
	}
	return out.String()
}

func isPDFDelimiterOrSpace(b byte) bool {
	switch b {
	case ' ', '\t', '\r', '\n', '\f', 0, '>', ']', ')', '/', '%':
		return true
	}
	return false
}

func lastPDFDict(slice []byte) []byte {
	start := bytes.LastIndex(slice, []byte("<<"))
	if start >= 0 {
		return slice[start:]
	}
	return slice
}

func hasPDFFlateFilter(dictContext []byte) bool {
	dict := lastPDFDict(dictContext)
	return bytes.Contains(dict, []byte("/FlateDecode")) ||
		bytes.Contains(dict, []byte("/Fl ")) ||
		bytes.Contains(dict, []byte("/Fl\n")) ||
		bytes.Contains(dict, []byte("/Fl\r")) ||
		bytes.Contains(dict, []byte("/Fl]")) ||
		bytes.Contains(dict, []byte("/Fl>"))
}

func hasPDFImageFilter(dictContext []byte) bool {
	dict := lastPDFDict(dictContext)
	for _, tok := range [][]byte{
		[]byte("/DCTDecode"),
		[]byte("/JPXDecode"),
		[]byte("/JBIG2Decode"),
		[]byte("/CCITTFaxDecode"),
	} {
		if bytes.Contains(dict, tok) {
			return true
		}
	}
	return false
}

func inflatePDFStream(raw []byte) ([]byte, bool) {
	tryInflate := func(in []byte) ([]byte, bool) {
		zr, err := zlib.NewReader(bytes.NewReader(in))
		if err != nil {
			return nil, false
		}
		defer zr.Close()
		out, err := io.ReadAll(io.LimitReader(zr, maxAttachmentPDFStreamBytes))
		if err != nil && len(out) == 0 {
			return nil, false
		}
		return out, len(out) > 0
	}
	if out, ok := tryInflate(raw); ok {
		return out, true
	}
	if trimmed := bytes.TrimLeft(raw, "\r\n"); len(trimmed) < len(raw) {
		return tryInflate(trimmed)
	}
	return nil, false
}

type pdfTokenKind int

const (
	pdfTokOp pdfTokenKind = iota
	pdfTokString
	pdfTokNumber
	pdfTokArray
)

type pdfToken struct {
	kind  pdfTokenKind
	text  string
	num   float64
	items []pdfToken
}

func parsePDFContentStream(stream []byte) string {
	tokens := tokenizePDFStream(stream)
	var out strings.Builder
	var operands []pdfToken
	inBT := false

	appendSep := func(sep byte) {
		if out.Len() == 0 {
			return
		}
		s := out.String()
		last := s[len(s)-1]
		if sep == '\n' {
			if last != '\n' {
				out.WriteByte('\n')
			}
		} else if last != ' ' && last != '\n' && last != '\t' {
			out.WriteByte(sep)
		}
	}

	emitString := func(s string) {
		if s == "" {
			return
		}
		out.WriteString(s)
	}

	for _, tok := range tokens {
		if tok.kind != pdfTokOp {
			operands = append(operands, tok)
			continue
		}
		op := tok.text
		switch op {
		case "BT":
			inBT = true
		case "ET":
			if inBT {
				appendSep('\n')
			}
			inBT = false
		case "Tj":
			if inBT && len(operands) >= 1 && operands[len(operands)-1].kind == pdfTokString {
				emitString(operands[len(operands)-1].text)
			}
		case "TJ":
			if inBT && len(operands) >= 1 && operands[len(operands)-1].kind == pdfTokArray {
				for _, item := range operands[len(operands)-1].items {
					switch item.kind {
					case pdfTokString:
						emitString(item.text)
					case pdfTokNumber:
						if item.num <= -150 {
							appendSep(' ')
						}
					}
				}
			}
		case "'":
			if inBT && len(operands) >= 1 && operands[len(operands)-1].kind == pdfTokString {
				appendSep('\n')
				emitString(operands[len(operands)-1].text)
			}
		case "\"":
			if inBT && len(operands) >= 1 && operands[len(operands)-1].kind == pdfTokString {
				appendSep('\n')
				emitString(operands[len(operands)-1].text)
			}
		case "T*":
			if inBT {
				appendSep('\n')
			}
		case "Td", "TD":
			if inBT {
				if len(operands) >= 2 && operands[len(operands)-1].kind == pdfTokNumber && operands[len(operands)-1].num != 0 {
					appendSep('\n')
				} else {
					appendSep(' ')
				}
			}
		case "Tm":
			if inBT {
				appendSep(' ')
			}
		}
		operands = operands[:0]
		if out.Len() >= maxExtractedAttachmentBytes {
			break
		}
	}
	return out.String()
}

func tokenizePDFStream(b []byte) []pdfToken {
	tokens := make([]pdfToken, 0, 64)
	i := 0
	n := len(b)

	skipSpaceAndComments := func() {
		for i < n {
			c := b[i]
			if c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '\f' || c == 0 {
				i++
				continue
			}
			if c == '%' {
				for i < n && b[i] != '\n' && b[i] != '\r' {
					i++
				}
				continue
			}
			break
		}
	}

	var readToken func() (pdfToken, bool)
	readToken = func() (pdfToken, bool) {
		skipSpaceAndComments()
		if i >= n {
			return pdfToken{}, false
		}
		c := b[i]
		switch c {
		case '(':
			i++
			return pdfToken{kind: pdfTokString, text: readPDFLiteralString(b, &i)}, true
		case '<':
			if i+1 < n && b[i+1] == '<' {
				i += 2
				return pdfToken{kind: pdfTokOp, text: "<<"}, true
			}
			i++
			return pdfToken{kind: pdfTokString, text: readPDFHexString(b, &i)}, true
		case '>':
			if i+1 < n && b[i+1] == '>' {
				i += 2
				return pdfToken{kind: pdfTokOp, text: ">>"}, true
			}
			i++
			return pdfToken{kind: pdfTokOp, text: ">"}, true
		case '[':
			i++
			var items []pdfToken
			for i < n {
				skipSpaceAndComments()
				if i >= n {
					break
				}
				if b[i] == ']' {
					i++
					break
				}
				sub, ok := readToken()
				if !ok {
					break
				}
				items = append(items, sub)
			}
			return pdfToken{kind: pdfTokArray, items: items}, true
		case ']':
			i++
			return pdfToken{kind: pdfTokOp, text: "]"}, true
		case '{', '}':
			i++
			return pdfToken{kind: pdfTokOp, text: string(c)}, true
		case '/':
			// PDF name object, e.g. /F1
			start := i
			i++
			for i < n && !isPDFTokenBreak(b[i]) {
				i++
			}
			return pdfToken{kind: pdfTokString, text: string(b[start:i])}, true
		default:
			start := i
			for i < n && !isPDFTokenBreak(b[i]) {
				i++
			}
			if i == start {
				i++
			}
			word := string(b[start:i])
			if num, err := strconv.ParseFloat(word, 64); err == nil {
				return pdfToken{kind: pdfTokNumber, num: num}, true
			}
			return pdfToken{kind: pdfTokOp, text: word}, true
		}
	}

	for i < n {
		tok, ok := readToken()
		if !ok {
			break
		}
		tokens = append(tokens, tok)
	}
	return tokens
}

func isPDFTokenBreak(c byte) bool {
	switch c {
	case ' ', '\t', '\r', '\n', '\f', 0, '(', ')', '<', '>', '[', ']', '{', '}', '/', '%':
		return true
	}
	return false
}

func readPDFLiteralString(b []byte, idx *int) string {
	var raw []byte
	depth := 1
	i := *idx
	n := len(b)
	for i < n && depth > 0 {
		c := b[i]
		i++
		if c == '\\' {
			if i >= n {
				break
			}
			esc := b[i]
			i++
			switch esc {
			case 'n':
				raw = append(raw, '\n')
			case 'r':
				raw = append(raw, '\r')
			case 't':
				raw = append(raw, '\t')
			case 'b':
				raw = append(raw, '\b')
			case 'f':
				raw = append(raw, '\f')
			case '(', ')', '\\':
				raw = append(raw, esc)
			case '\r':
				if i < n && b[i] == '\n' {
					i++
				}
			case '\n':
				// line continuation
			default:
				if esc >= '0' && esc <= '7' {
					val := int(esc - '0')
					for k := 0; k < 2 && i < n && b[i] >= '0' && b[i] <= '7'; k++ {
						val = val*8 + int(b[i]-'0')
						i++
					}
					raw = append(raw, byte(val&0xFF))
				} else {
					raw = append(raw, esc)
				}
			}
			continue
		}
		if c == '(' {
			depth++
			raw = append(raw, c)
		} else if c == ')' {
			depth--
			if depth > 0 {
				raw = append(raw, c)
			}
		} else {
			raw = append(raw, c)
		}
	}
	*idx = i
	return decodePDFStringBytes(raw)
}

func readPDFHexString(b []byte, idx *int) string {
	var hexDigits []byte
	i := *idx
	n := len(b)
	for i < n {
		c := b[i]
		i++
		if c == '>' {
			break
		}
		if isHexByte(c) {
			hexDigits = append(hexDigits, c)
		}
	}
	*idx = i
	if len(hexDigits) == 0 {
		return ""
	}
	if len(hexDigits)%2 == 1 {
		hexDigits = append(hexDigits, '0')
	}
	raw := make([]byte, len(hexDigits)/2)
	for j := 0; j < len(raw); j++ {
		raw[j] = (hexVal(hexDigits[j*2]) << 4) | hexVal(hexDigits[j*2+1])
	}
	return decodePDFStringBytes(raw)
}

func isHexByte(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

func hexVal(c byte) byte {
	switch {
	case c >= '0' && c <= '9':
		return c - '0'
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10
	}
	return 0
}

func decodePDFStringBytes(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}
	if len(raw) >= 2 && raw[0] == 0xFE && raw[1] == 0xFF {
		return decodeUTF16(raw[2:], binary.BigEndian)
	}
	if len(raw) >= 2 && raw[0] == 0xFF && raw[1] == 0xFE {
		return decodeUTF16(raw[2:], binary.LittleEndian)
	}
	if utf8.Valid(raw) {
		return string(raw)
	}
	// Fallback: interpret bytes as Latin-1 runes.
	var b strings.Builder
	b.Grow(len(raw))
	for _, ch := range raw {
		b.WriteRune(rune(ch))
	}
	return b.String()
}
