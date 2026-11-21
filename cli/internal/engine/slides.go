package engine

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"os"
	"sort"
	"strconv"
	"strings"
)

// SlidePageData represents one slide in a PPTX deck.
type SlidePageData struct {
	Index      int    `json:"index"`
	Title      string `json:"title"`
	Body       string `json:"body"`
	Background string `json:"background,omitempty"`
}

// DeckData is the pure-Go headless presentation model.
type DeckData struct {
	Title  string          `json:"title"`
	Slides []SlidePageData `json:"slides"`
}

// SlidePatchOp represents an atomic deck mutation.
type SlidePatchOp struct {
	Op         string `json:"op"`
	SlideIndex int    `json:"slideIndex,omitempty"`
	Title      string `json:"title,omitempty"`
	Body       string `json:"body,omitempty"`
	Background string `json:"background,omitempty"`
}

// SlideDiag reports layout or content issues on a slide.
type SlideDiag struct {
	Code       string `json:"code"`
	Severity   string `json:"severity"`
	SlideIndex int    `json:"slideIndex"`
	Message    string `json:"message"`
	Suggestion string `json:"suggestion"`
}

// LoadDeck reads a .pptx file into DeckData.
func LoadDeck(path string) (*DeckData, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return ParsePPTX(raw)
}

// SaveDeck writes DeckData to a DEFLATE-compressed .pptx file.
func SaveDeck(path string, deck *DeckData) error {
	b, err := WritePPTX(deck)
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}

// ParsePPTX parses slide texts from a standard OOXML .pptx archive.
func ParsePPTX(data []byte) (*DeckData, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("invalid pptx zip: %w", err)
	}
	type indexedSlide struct {
		num  int
		file *zip.File
	}
	var slides []indexedSlide
	for _, f := range zr.File {
		name := strings.ReplaceAll(f.Name, "\\", "/")
		if strings.HasPrefix(name, "ppt/slides/slide") && strings.HasSuffix(name, ".xml") {
			numStr := strings.TrimSuffix(strings.TrimPrefix(name, "ppt/slides/slide"), ".xml")
			if n, err := strconv.Atoi(numStr); err == nil {
				slides = append(slides, indexedSlide{num: n, file: f})
			}
		}
	}
	sort.Slice(slides, func(i, j int) bool { return slides[i].num < slides[j].num })
	if len(slides) == 0 {
		return nil, fmt.Errorf("no slides found in pptx")
	}

	deck := &DeckData{Title: "Presentation"}
	for idx, sf := range slides {
		rc, err := sf.file.Open()
		if err != nil {
			continue
		}
		raw, _ := io.ReadAll(io.LimitReader(rc, 4*1024*1024))
		rc.Close()
		title, body := extractSlideXMLTexts(raw)
		if idx == 0 && title != "" {
			deck.Title = title
		}
		deck.Slides = append(deck.Slides, SlidePageData{
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

// WritePPTX serializes DeckData into a valid 16:9 OOXML .pptx archive.
func WritePPTX(deck *DeckData) ([]byte, error) {
	var entries []zipEntry

	slides := deck.Slides
	if len(slides) == 0 {
		slides = []SlidePageData{{Index: 0, Title: deck.Title}}
	}
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

// Inspect returns a compact slide deck summary.
func (d *DeckData) Inspect() map[string]any {
	return map[string]any{
		"title":      d.Title,
		"slideCount": len(d.Slides),
		"slides":     d.Slides,
	}
}

// Apply atomically mutates slides with optional dryRun.
func (d *DeckData) Apply(ops []SlidePatchOp, dryRun bool) (int, []string, error) {
	backup := append([]SlidePageData(nil), d.Slides...)
	var diff []string
	for i, op := range ops {
		switch op.Op {
		case "addSlide":
			d.Slides = append(d.Slides, SlidePageData{
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

// Verify inspects slides for empty deck, empty slides, and text overflow.
func (d *DeckData) Verify() []SlideDiag {
	var diags []SlideDiag
	if len(d.Slides) == 0 {
		return []SlideDiag{{
			Code: "EMPTY_DECK", Severity: "error", SlideIndex: -1,
			Message: "Deck contains 0 slides.", Suggestion: "Add at least one slide.",
		}}
	}
	for i, s := range d.Slides {
		if strings.TrimSpace(s.Title) == "" && strings.TrimSpace(s.Body) == "" {
			diags = append(diags, SlideDiag{
				Code: "EMPTY_SLIDE", Severity: "warning", SlideIndex: i,
				Message: fmt.Sprintf("Slide %d has no content.", i+1), Suggestion: "Add a title or delete the slide.",
			})
		}
		if len([]rune(s.Body)) > 800 {
			diags = append(diags, SlideDiag{
				Code: "TEXT_OVERFLOW", Severity: "warning", SlideIndex: i,
				Message: fmt.Sprintf("Slide %d body has %d characters and may overflow.", i+1, len([]rune(s.Body))),
				Suggestion: "Split dense text across multiple slides.",
			})
		}
	}
	return diags
}

// RenderSlideSVG renders a slide as a deterministic 16:9 SVG document.
func (d *DeckData) RenderSlideSVG(index int) (string, error) {
	if index < 0 || index >= len(d.Slides) {
		return "", fmt.Errorf("slideIndex %d out of range", index)
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
