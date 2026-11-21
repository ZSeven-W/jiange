package slides

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
)

// Slide represents one slide page in a presentation Deck.
type Slide struct {
	Index      int    `json:"index"`
	Title      string `json:"title"`
	Body       string `json:"body"`
	Background string `json:"background,omitempty"`
}

// Deck is the pure-Go headless presentation model.
type Deck struct {
	Title  string  `json:"title"`
	Slides []Slide `json:"slides"`
}

// Op represents an atomic presentation mutation (addSlide, updateSlide, deleteSlide).
type Op struct {
	Op         string `json:"op"`
	SlideIndex int    `json:"slideIndex,omitempty"`
	Title      string `json:"title,omitempty"`
	Body       string `json:"body,omitempty"`
	Background string `json:"background,omitempty"`
}

// Diagnostic reports deck or slide layout/content issues.
type Diagnostic struct {
	Code       string `json:"code"`
	Severity   string `json:"severity"`
	SlideIndex int    `json:"slideIndex"`
	Message    string `json:"message"`
	Suggestion string `json:"suggestion"`
}

var newBytesWriter = func(buf *bytes.Buffer) io.Writer { return buf }

// ParsePPTX parses slide titles and body text from a standard OOXML .pptx archive.
func ParsePPTX(data []byte) (*Deck, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("slides: invalid pptx zip: %w", err)
	}
	type indexedSlide struct {
		num  int
		file *zip.File
	}
	var entries []indexedSlide
	for _, f := range zr.File {
		name := strings.ReplaceAll(f.Name, "\\", "/")
		if strings.HasPrefix(name, "ppt/slides/slide") && strings.HasSuffix(name, ".xml") {
			numStr := strings.TrimSuffix(strings.TrimPrefix(name, "ppt/slides/slide"), ".xml")
			if n, err := strconv.Atoi(numStr); err == nil {
				entries = append(entries, indexedSlide{num: n, file: f})
			}
		}
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].num < entries[j].num })
	if len(entries) == 0 {
		return nil, errors.New("slides: no slides found in pptx")
	}

	deck := &Deck{Title: "Presentation", Slides: make([]Slide, 0, len(entries))}
	for idx, sf := range entries {
		rc, err := sf.file.Open()
		if err != nil {
			return nil, err
		}
		raw, err := io.ReadAll(io.LimitReader(rc, 4*1024*1024))
		_ = rc.Close()
		if err != nil {
			return nil, err
		}
		title, body := extractSlideXMLTexts(raw)
		if idx == 0 && title != "" {
			deck.Title = title
		}
		deck.Slides = append(deck.Slides, Slide{
			Index: idx,
			Title: title,
			Body:  body,
		})
	}
	return deck, nil
}

func extractSlideXMLTexts(raw []byte) (string, string) {
	dec := xml.NewDecoder(bytes.NewReader(raw))
	var texts []string
	var cur strings.Builder
	inT := false
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			if t.Name.Local == "t" {
				inT = true
				cur.Reset()
			}
		case xml.CharData:
			if inT {
				cur.Write(t)
			}
		case xml.EndElement:
			if t.Name.Local == "t" && inT {
				inT = false
				if s := strings.TrimSpace(cur.String()); s != "" {
					texts = append(texts, s)
				}
			}
		}
	}
	if len(texts) == 0 {
		return "", ""
	}
	return texts[0], strings.Join(texts[1:], "\n")
}

type zipEntry struct {
	name string
	body string
}

// WritePPTX serializes a Deck into a DEFLATE-compressed 16:9 OOXML .pptx archive.
func WritePPTX(deck *Deck) ([]byte, error) {
	if deck == nil {
		deck = &Deck{Title: "Presentation"}
	}
	slides := deck.Slides
	if len(slides) == 0 {
		slides = []Slide{{Index: 0, Title: deck.Title}}
	}
	var entries []zipEntry
	var ctOv, sldIdLst, presRels strings.Builder
	for i, s := range slides {
		n := i + 1
		ctOv.WriteString(fmt.Sprintf(`<Override PartName="/ppt/slides/slide%d.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`, n))
		sldIdLst.WriteString(fmt.Sprintf(`<p:sldId id="%d" r:id="rId%d"/>`, 256+i, n))
		presRels.WriteString(fmt.Sprintf(`<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide%d.xml"/>`, n, n))

		slideXML := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
			`<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
			`<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
			fmt.Sprintf(`<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>%s</a:t></a:r></a:p></p:txBody></p:sp>`, xmlEscape(s.Title)) +
			fmt.Sprintf(`<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>%s</a:t></a:r></a:p></p:txBody></p:sp>`, xmlEscape(s.Body)) +
			`</p:spTree></p:cSld></p:sld>`
		entries = append(entries, zipEntry{name: fmt.Sprintf("ppt/slides/slide%d.xml", n), body: slideXML})
	}

	ctXML := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
		`<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
		`<Default Extension="xml" ContentType="application/xml"/>` +
		`<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
		ctOv.String() + `</Types>`
	relsXML := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
		`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>` +
		`</Relationships>`
	presXML := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
		`<p:sldIdLst>` + sldIdLst.String() + `</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/></p:presentation>`
	presRelsXML := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` + presRels.String() + `</Relationships>`

	entries = append(entries,
		zipEntry{name: "[Content_Types].xml", body: ctXML},
		zipEntry{name: "_rels/.rels", body: relsXML},
		zipEntry{name: "ppt/presentation.xml", body: presXML},
		zipEntry{name: "ppt/_rels/presentation.xml.rels", body: presRelsXML},
	)
	return buildZipBytes(entries)
}

func buildZipBytes(entries []zipEntry) ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(newBytesWriter(&buf))
	for _, e := range entries {
		fw, err := zw.Create(e.name)
		if err != nil {
			return nil, err
		}
		if _, err := io.WriteString(fw, e.body); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func xmlEscape(s string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

// Inspect returns a structured slide deck overview.
func (d *Deck) Inspect() map[string]any {
	return map[string]any{
		"title":      d.Title,
		"slideCount": len(d.Slides),
		"slides":     d.Slides,
	}
}

// Apply atomically mutates slides with rollback on error or dryRun.
func (d *Deck) Apply(ops []Op, dryRun bool) (int, []string, error) {
	backup := append([]Slide(nil), d.Slides...)
	var diff []string
	for i, op := range ops {
		switch op.Op {
		case "addSlide":
			d.Slides = append(d.Slides, Slide{
				Index:      len(d.Slides),
				Title:      op.Title,
				Body:       op.Body,
				Background: op.Background,
			})
			diff = append(diff, fmt.Sprintf("added slide %d (%s)", len(d.Slides)-1, op.Title))
		case "updateSlide":
			if op.SlideIndex < 0 || op.SlideIndex >= len(d.Slides) {
				d.Slides = backup
				return 0, nil, fmt.Errorf("op[%d]: slideIndex %d out of range", i, op.SlideIndex)
			}
			if op.Title != "" {
				d.Slides[op.SlideIndex].Title = op.Title
			}
			if op.Body != "" {
				d.Slides[op.SlideIndex].Body = op.Body
			}
			if op.Background != "" {
				d.Slides[op.SlideIndex].Background = op.Background
			}
			diff = append(diff, fmt.Sprintf("updated slide %d", op.SlideIndex))
		case "deleteSlide":
			if op.SlideIndex < 0 || op.SlideIndex >= len(d.Slides) {
				d.Slides = backup
				return 0, nil, fmt.Errorf("op[%d]: slideIndex %d out of range", i, op.SlideIndex)
			}
			d.Slides = append(d.Slides[:op.SlideIndex], d.Slides[op.SlideIndex+1:]...)
			for si := range d.Slides {
				d.Slides[si].Index = si
			}
			diff = append(diff, fmt.Sprintf("deleted slide %d", op.SlideIndex))
		default:
			d.Slides = backup
			return 0, nil, fmt.Errorf("op[%d]: unsupported op %q", i, op.Op)
		}
	}
	if dryRun {
		d.Slides = backup
	}
	return len(diff), diff, nil
}

// Verify checks for empty deck, empty slides, and text overflow.
func (d *Deck) Verify() []Diagnostic {
	diags := make([]Diagnostic, 0)
	if len(d.Slides) == 0 {
		return []Diagnostic{{
			Code:       "EMPTY_DECK",
			Severity:   "error",
			SlideIndex: -1,
			Message:    "Deck contains 0 slides.",
			Suggestion: "Add at least one slide.",
		}}
	}
	for i, s := range d.Slides {
		if strings.TrimSpace(s.Title) == "" && strings.TrimSpace(s.Body) == "" {
			diags = append(diags, Diagnostic{
				Code:       "EMPTY_SLIDE",
				Severity:   "warning",
				SlideIndex: i,
				Message:    fmt.Sprintf("Slide %d has no content.", i+1),
				Suggestion: "Add a title or delete the slide.",
			})
		}
		if len([]rune(s.Body)) > 800 {
			diags = append(diags, Diagnostic{
				Code:       "TEXT_OVERFLOW",
				Severity:   "warning",
				SlideIndex: i,
				Message:    fmt.Sprintf("Slide %d body has %d characters and may overflow.", i+1, len([]rune(s.Body))),
				Suggestion: "Split dense text across multiple slides.",
			})
		}
	}
	return diags
}

// RenderSlideSVG renders slide at index as a deterministic 16:9 SVG document.
func (d *Deck) RenderSlideSVG(index int) (string, error) {
	if index < 0 || index >= len(d.Slides) {
		return "", fmt.Errorf("slides: slideIndex %d out of range", index)
	}
	s := d.Slides[index]
	bg := s.Background
	if bg == "" {
		bg = "#ffffff"
	}
	var bodyTspans strings.Builder
	for li, line := range strings.Split(s.Body, "\n") {
		bodyTspans.WriteString(fmt.Sprintf(`<tspan x="76" y="%d">%s</tspan>`, 210+li*36, xmlEscape(line)))
	}
	return fmt.Sprintf(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720">`+
			`<rect width="1280" height="720" fill="%s"/>`+
			`<text x="76" y="110" font-family="sans-serif" font-size="40" font-weight="700" fill="#1f2329">%s</text>`+
			`<text font-family="sans-serif" font-size="24" fill="#374151">%s</text></svg>`,
		xmlEscape(bg), xmlEscape(s.Title), bodyTspans.String(),
	), nil
}
