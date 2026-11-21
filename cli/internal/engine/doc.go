package engine

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// DocBlock is a semantic document block (heading, paragraph, list, code, quote).
type DocBlock struct {
	ID    string `json:"id"`
	Type  string `json:"type"`
	Level int    `json:"level,omitempty"`
	Text  string `json:"text"`
}

// DocData is the pure-Go headless document model.
type DocData struct {
	Title  string     `json:"title"`
	Blocks []DocBlock `json:"blocks"`
}

// DocOp represents a structured document edit operation.
type DocOp struct {
	Op          string `json:"op"`
	BlockID     string `json:"blockId,omitempty"`
	Type        string `json:"type,omitempty"`
	Level       int    `json:"level,omitempty"`
	Text        string `json:"text,omitempty"`
	Search      string `json:"search,omitempty"`
	Replacement string `json:"replacement,omitempty"`
}

// DocDiagnostic reports structural issues in a document.
type DocDiagnostic struct {
	Code       string `json:"code"`
	Severity   string `json:"severity"`
	BlockID    string `json:"blockId,omitempty"`
	Message    string `json:"message"`
	Suggestion string `json:"suggestion"`
}

// LoadDoc loads a .docx or .md/.txt file into DocData.
func LoadDoc(path string) (*DocData, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	title := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	if strings.EqualFold(filepath.Ext(path), ".docx") {
		return ParseDOCX(raw, title)
	}
	return ParseMarkdownDoc(string(raw), title), nil
}

// SaveDoc writes DocData to .docx or .md based on extension.
func SaveDoc(path string, doc *DocData) error {
	if strings.EqualFold(filepath.Ext(path), ".docx") {
		b, err := WriteDOCX(doc)
		if err != nil {
			return err
		}
		return os.WriteFile(path, b, 0o644)
	}
	return os.WriteFile(path, []byte(doc.ToMarkdown()), 0o644)
}

// ParseMarkdownDoc parses Markdown text into semantic DocBlocks.
func ParseMarkdownDoc(md, title string) *DocData {
	doc := &DocData{Title: title}
	lines := strings.Split(strings.ReplaceAll(md, "\r\n", "\n"), "\n")
	seq := 1
	inCode := false
	var codeBuf []string
	for _, line := range lines {
		trim := strings.TrimSpace(line)
		if strings.HasPrefix(trim, "```") {
			if inCode {
				doc.Blocks = append(doc.Blocks, DocBlock{
					ID:   fmt.Sprintf("b%d", seq),
					Type: "code",
					Text: strings.Join(codeBuf, "\n"),
				})
				seq++
				codeBuf = nil
				inCode = false
			} else {
				inCode = true
			}
			continue
		}
		if inCode {
			codeBuf = append(codeBuf, line)
			continue
		}
		if trim == "" {
			continue
		}
		if strings.HasPrefix(trim, "#") {
			lvl := 0
			for lvl < len(trim) && lvl < 6 && trim[lvl] == '#' {
				lvl++
			}
			if lvl < len(trim) && trim[lvl] == ' ' {
				doc.Blocks = append(doc.Blocks, DocBlock{
					ID:    fmt.Sprintf("b%d", seq),
					Type:  "heading",
					Level: lvl,
					Text:  strings.TrimSpace(trim[lvl:]),
				})
				seq++
				continue
			}
		}
		if strings.HasPrefix(trim, "- ") || strings.HasPrefix(trim, "* ") {
			doc.Blocks = append(doc.Blocks, DocBlock{
				ID:   fmt.Sprintf("b%d", seq),
				Type: "bullet",
				Text: strings.TrimSpace(trim[2:]),
			})
			seq++
			continue
		}
		if strings.HasPrefix(trim, "> ") {
			doc.Blocks = append(doc.Blocks, DocBlock{
				ID:   fmt.Sprintf("b%d", seq),
				Type: "quote",
				Text: strings.TrimSpace(trim[2:]),
			})
			seq++
			continue
		}
		doc.Blocks = append(doc.Blocks, DocBlock{
			ID:   fmt.Sprintf("b%d", seq),
			Type: "paragraph",
			Text: trim,
		})
		seq++
	}
	return doc
}

// ToMarkdown exports DocData to Markdown.
func (d *DocData) ToMarkdown() string {
	var parts []string
	for _, b := range d.Blocks {
		switch b.Type {
		case "heading":
			lvl := b.Level
			if lvl < 1 || lvl > 6 {
				lvl = 1
			}
			parts = append(parts, strings.Repeat("#", lvl)+" "+b.Text)
		case "bullet":
			parts = append(parts, "- "+b.Text)
		case "quote":
			parts = append(parts, "> "+b.Text)
		case "code":
			parts = append(parts, "```\n"+b.Text+"\n```")
		default:
			parts = append(parts, b.Text)
		}
	}
	return strings.Join(parts, "\n\n") + "\n"
}

// ParseDOCX parses word/document.xml from a .docx archive.
func ParseDOCX(data []byte, title string) (*DocData, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("invalid docx zip: %w", err)
	}
	var docXML []byte
	for _, f := range zr.File {
		if strings.ReplaceAll(f.Name, "\\", "/") == "word/document.xml" {
			rc, err := f.Open()
			if err != nil {
				return nil, err
			}
			docXML, err = io.ReadAll(io.LimitReader(rc, 16*1024*1024))
			rc.Close()
			if err != nil {
				return nil, err
			}
			break
		}
	}
	if len(docXML) == 0 {
		return nil, fmt.Errorf("word/document.xml not found")
	}

	type xmlRun struct {
		T []string `xml:"t"`
	}
	type xmlPara struct {
		PPr struct {
			PStyle struct {
				Val string `xml:"val,attr"`
			} `xml:"pStyle"`
		} `xml:"pPr"`
		Runs []xmlRun `xml:"r"`
	}
	var body struct {
		Paras []xmlPara `xml:"body>p"`
	}
	if err := xml.Unmarshal(docXML, &body); err != nil {
		return nil, err
	}
	doc := &DocData{Title: title}
	seq := 1
	for _, p := range body.Paras {
		var sb strings.Builder
		for _, r := range p.Runs {
			for _, t := range r.T {
				sb.WriteString(t)
			}
		}
		text := sb.String()
		if strings.TrimSpace(text) == "" {
			continue
		}
		style := p.PPr.PStyle.Val
		bType := "paragraph"
		lvl := 0
		if strings.HasPrefix(strings.ToLower(style), "heading") {
			bType = "heading"
			lvl = 1
			if len(style) > 7 {
				if n := int(style[len(style)-1] - '0'); n >= 1 && n <= 6 {
					lvl = n
				}
			}
		}
		doc.Blocks = append(doc.Blocks, DocBlock{
			ID:    fmt.Sprintf("b%d", seq),
			Type:  bType,
			Level: lvl,
			Text:  text,
		})
		seq++
	}
	return doc, nil
}

// WriteDOCX serializes DocData to a DEFLATE-compressed OOXML .docx archive.
func WriteDOCX(doc *DocData) ([]byte, error) {
	var body strings.Builder
	for _, b := range doc.Blocks {
		pPr := ""
		if b.Type == "heading" {
			lvl := b.Level
			if lvl < 1 || lvl > 6 {
				lvl = 1
			}
			pPr = fmt.Sprintf(`<w:pPr><w:pStyle w:val="Heading%d"/></w:pPr>`, lvl)
		}
		body.WriteString(fmt.Sprintf(`<w:p>%s<w:r><w:t xml:space="preserve">%s</w:t></w:r></w:p>`, pPr, xmlEscape(b.Text)))
	}

	docXML := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
		body.String() + `</w:body></w:document>`
	ctXML := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
		`<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
		`<Default Extension="xml" ContentType="application/xml"/>` +
		`<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
		`</Types>`
	relsXML := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
		`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
		`</Relationships>`

	return buildZipBytes([]zipEntry{
		{name: "[Content_Types].xml", body: ctXML},
		{name: "_rels/.rels", body: relsXML},
		{name: "word/document.xml", body: docXML},
	})
}

// Inspect returns a structured outline and block summary.
func (d *DocData) Inspect(detail string) map[string]any {
	var outline []map[string]any
	words := 0
	for _, b := range d.Blocks {
		words += len(strings.Fields(b.Text))
		if b.Type == "heading" {
			outline = append(outline, map[string]any{"id": b.ID, "level": b.Level, "text": b.Text})
		}
	}
	res := map[string]any{
		"title":      d.Title,
		"blockCount": len(d.Blocks),
		"wordCount":  words,
		"outline":    outline,
	}
	if detail == "full" {
		res["blocks"] = d.Blocks
	}
	return res
}

// Query finds blocks matching a keyword or block type.
func (d *DocData) Query(text, blockType string) []DocBlock {
	needle := strings.ToLower(strings.TrimSpace(text))
	var out []DocBlock
	for _, b := range d.Blocks {
		if blockType != "" && b.Type != blockType {
			continue
		}
		if needle != "" && !strings.Contains(strings.ToLower(b.Text), needle) {
			continue
		}
		out = append(out, b)
	}
	return out
}

// Apply atomically applies document mutations with optional dryRun.
func (d *DocData) Apply(ops []DocOp, dryRun bool) (int, []string, error) {
	backup := append([]DocBlock(nil), d.Blocks...)
	var diff []string
	for i, op := range ops {
		switch op.Op {
		case "appendBlock":
			bt := op.Type
			if bt == "" {
				bt = "paragraph"
			}
			id := fmt.Sprintf("b%d", len(d.Blocks)+1)
			d.Blocks = append(d.Blocks, DocBlock{ID: id, Type: bt, Level: op.Level, Text: op.Text})
			diff = append(diff, fmt.Sprintf("appended %s %s", bt, id))
		case "replaceText":
			if op.Search == "" {
				d.Blocks = backup
				return 0, nil, fmt.Errorf("op[%d]: empty search term", i)
			}
			hits := 0
			for bi := range d.Blocks {
				if d.Blocks[bi].Type == "code" {
					continue
				}
				if strings.Contains(d.Blocks[bi].Text, op.Search) {
					d.Blocks[bi].Text = strings.ReplaceAll(d.Blocks[bi].Text, op.Search, op.Replacement)
					hits++
				}
			}
			diff = append(diff, fmt.Sprintf("replaced %q in %d blocks", op.Search, hits))
		case "deleteBlock":
			idx := -1
			for bi, b := range d.Blocks {
				if b.ID == op.BlockID {
					idx = bi
					break
				}
			}
			if idx < 0 {
				d.Blocks = backup
				return 0, nil, fmt.Errorf("op[%d]: block %q not found", i, op.BlockID)
			}
			d.Blocks = append(d.Blocks[:idx], d.Blocks[idx+1:]...)
			diff = append(diff, fmt.Sprintf("deleted block %s", op.BlockID))
		default:
			d.Blocks = backup
			return 0, nil, fmt.Errorf("op[%d]: unsupported op %q", i, op.Op)
		}
	}
	if dryRun {
		d.Blocks = backup
	}
	return len(diff), diff, nil
}

// Verify checks document structure (empty doc, skipped heading levels).
func (d *DocData) Verify() []DocDiagnostic {
	var diags []DocDiagnostic
	if len(d.Blocks) == 0 {
		diags = append(diags, DocDiagnostic{
			Code:       "EMPTY_DOC",
			Severity:   "warning",
			Message:    "Document has 0 blocks.",
			Suggestion: "Append headings or paragraphs before exporting.",
		})
		return diags
	}
	prevLevel := 0
	for _, b := range d.Blocks {
		if b.Type == "heading" {
			if prevLevel > 0 && b.Level > prevLevel+1 {
				diags = append(diags, DocDiagnostic{
					Code:       "SKIPPED_HEADING_LEVEL",
					Severity:   "warning",
					BlockID:    b.ID,
					Message:    fmt.Sprintf("Heading %q jumps from H%d to H%d.", b.Text, prevLevel, b.Level),
					Suggestion: fmt.Sprintf("Use H%d instead of H%d for clean outline hierarchy.", prevLevel+1, b.Level),
				})
			}
			prevLevel = b.Level
		}
	}
	return diags
}
