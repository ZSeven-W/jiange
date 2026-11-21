import { describe, expect, it, vi } from "vitest";
import { createZip } from "@jiange/ooxml/zip";
import {
  Presentation,
  createSlidesTools,
  exportSlidesToPptx,
  moveSlideLineEndpoint,
  parsePptxToSlides,
  parseSlideZoom,
  patchSlideShape,
  PptxError,
  renderSlideToSvg,
  resizeSlideShape,
  slideLineEndpoints,
  slidePositions,
  verifySlideOrder,
  type PptxSlideInput,
  type SlideOp,
  type SlideShape,
  type SlidesPage,
} from "../src/index.js";

const enc = (s: string) => new TextEncoder().encode(s);

function makePage(overrides: Partial<SlidesPage> = {}): SlidesPage {
  return {
    id: 1,
    slidesId: 1,
    pos: 1000,
    title: "",
    body: "",
    background: "",
    layout: "",
    notes: "",
    shapes: [],
    hidden: false,
    revision: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("@jiange/slides-sdk helpers full branch coverage", () => {
  it("covers line-endpoints, order, shape-resize, shape-state, zoom, and ai-tools edge branches", () => {
    // line-endpoints: default width/height, invalid canvas/delta, start & end move, width < 5, width > 100, out-of-bounds
    const defaultLine: SlideShape = { id: "ln", kind: "line", x: 40, y: 40, color: "#000" };
    const pts = slideLineEndpoints(defaultLine, 1000, 500);
    expect(pts.start.x).toBeLessThan(pts.end.x);

    expect(moveSlideLineEndpoint(defaultLine, "end", 10, 0, 0, 500)).toBe(defaultLine);
    expect(moveSlideLineEndpoint(defaultLine, "end", 10, 0, 1000, 0)).toBe(defaultLine);
    expect(moveSlideLineEndpoint(defaultLine, "end", Number.NaN, 0, 1000, 500)).toBe(defaultLine);
    expect(moveSlideLineEndpoint(defaultLine, "end", 0, Number.POSITIVE_INFINITY, 1000, 500)).toBe(defaultLine);

    // Move start and end validly
    const movedStart = moveSlideLineEndpoint(defaultLine, "start", -20, 0, 1000, 500);
    expect(movedStart.width).toBeGreaterThan(16);
    const movedEnd = moveSlideLineEndpoint(defaultLine, "end", 20, 0, 1000, 500);
    expect(movedEnd.width).toBeGreaterThan(16);

    // Width < 5 rejected
    const tinyReject = moveSlideLineEndpoint(
      { id: "ln2", kind: "line", x: 40, y: 40, width: 10, height: 10, color: "#000" },
      "start",
      80,
      0,
      1000,
      500,
    );
    expect(tinyReject.width).toBe(10);

    // Width > 100 rejected (length / 0.9 > canvasWidth)
    const wideReject = moveSlideLineEndpoint(
      { id: "ln3", kind: "line", x: 5, y: 10, width: 85, height: 10, color: "#000" },
      "end",
      500,
      450,
      1000,
      1000,
    );
    expect(wideReject.width).toBe(85);

    // Bounding box out of 0..100 rejected (x < 0 / y < 0 / x+w > 100 / y+h > 100)
    const oobYReject = moveSlideLineEndpoint(
      { id: "ln4", kind: "line", x: 30, y: 2, width: 20, height: 20, color: "#000" },
      "end",
      0,
      -500,
      1000,
      500,
    );
    expect(oobYReject.y).toBe(2);

    // order.ts: slidePositions & verifySlideOrder edge rejections
    const pages = [makePage({ id: 10, pos: 1 }), makePage({ id: 20, pos: 2 })];
    const pos = slidePositions(pages);
    expect(pos).toEqual([
      { id: 10, pos: 1 },
      { id: 20, pos: 2 },
    ]);
    expect(verifySlideOrder(pos, 10, -1, pos)).toBeNull();
    expect(verifySlideOrder(pos, 10, 2, pos)).toBeNull();
    expect(verifySlideOrder(pos, 999, 1, pos)).toBeNull();
    expect(verifySlideOrder(pos, 10, 0, pos)).toBeNull();

    // shape-resize.ts: west handle, north/south handles (sx === 0), default width/height
    const unsized: SlideShape = { id: "r1", kind: "rectangle", x: 20, y: 20, color: "#3370ff" };
    const resizedW = resizeSlideShape(unsized, "w", -20, 0, 1000, 500);
    expect(resizedW.width).toBeGreaterThan(16);
    const resizedN = resizeSlideShape(unsized, "n", 0, -25, 1000, 500);
    expect(resizedN.width).toBe(16);
    expect(resizedN.height).toBeGreaterThan(20);

    // shape-state.ts: default width/height when omitted
    const patched = patchSlideShape([unsized], "r1", { x: 95, y: 95 });
    expect(patched[0].x).toBe(84);
    expect(patched[0].y).toBe(80);

    // zoom.ts: finite overflow returns null
    expect(parseSlideZoom("9".repeat(400))).toBeNull();

    // ai-tools.ts: omitted ops and omitted slideIndex
    const deck = Presentation.create({ title: "Tools Edge" });
    const rt = createSlidesTools(deck);
    expect((rt.execute("slides_apply") as { ok: boolean; applied: number }).applied).toBe(0);
    expect((rt.execute("slides_render_svg") as { svg: string }).svg).toContain("<svg ");
  });

  it("covers all SVG rendering branches", () => {
    // Empty/invalid background colors, undefined layout & shapes
    const svgInvalidBg = renderSlideToSvg(
      {
        title: "",
        body: "",
        background: "not-a-hex",
        layout: undefined as unknown as "",
        shapes: undefined as unknown as SlideShape[],
      },
      { theme: { background: "" } },
    );
    expect(svgInvalidBg).toContain("<svg ");

    const svgNoBg = renderSlideToSvg(
      { title: "", body: "", background: "", layout: "title", shapes: [] },
      { theme: { background: "" } },
    );
    expect(svgNoBg).toContain("<svg ");

    // Title layout with body + narrow wrapping text + right-aligned text + empty text + paragraphs without bullet + missing table/chart + empty/jagged tables + chart edge cases + opacity + missing width/height/color
    const svg = renderSlideToSvg({
      title: "Cover Title",
      body: "Subtitle Body",
      background: "#fff",
      layout: "title",
      shapes: [
        {
          id: "wrap-right",
          kind: "text",
          x: 5,
          y: 10,
          width: 10,
          height: 30,
          color: "",
          opacity: 0.75,
          align: "right",
          fontSize: 20,
          text: "A very long line of text that must definitely wrap across multiple lines in a narrow box",
        },
        {
          id: "empty-text",
          kind: "text",
          x: 20,
          y: 10,
          color: "#000",
        },
        {
          id: "para-nobullet",
          kind: "text",
          x: 20,
          y: 35,
          width: 25,
          height: 15,
          color: "#111",
          paragraphs: [{ bullet: false, runs: [{ text: "Plain paragraph" }] }],
        },
        { id: "tbl-undef", kind: "table", x: 5, y: 50, width: 10, height: 10, color: "#000" },
        {
          id: "tbl-empty",
          kind: "table",
          x: 20,
          y: 50,
          width: 20,
          height: 15,
          color: "#000",
          table: { rows: [] },
        },
        {
          id: "tbl-jagged",
          kind: "table",
          x: 42,
          y: 50,
          width: 20,
          height: 15,
          color: "#000",
          table: {
            headerRow: false,
            rows: [["R0C0", "R0C1"], ["R1C0"], ["R2C0", "R2C1"]],
          },
        },
        { id: "cht-undef", kind: "chart", x: 65, y: 50, width: 10, height: 10, color: "#000" },
        {
          id: "cht-pie-empty",
          kind: "chart",
          x: 5,
          y: 70,
          width: 18,
          height: 18,
          color: "#000",
          chart: { type: "pie", categories: [], series: [] },
        },
        {
          id: "cht-pie-zero",
          kind: "chart",
          x: 25,
          y: 70,
          width: 18,
          height: 18,
          color: "#000",
          chart: { type: "pie", categories: ["A"], series: [{ name: "S", values: [0] }] },
        },
        {
          id: "cht-line-single",
          kind: "chart",
          x: 45,
          y: 70,
          width: 18,
          height: 18,
          color: "#000",
          chart: { type: "line", categories: ["Only"], series: [{ name: "S", color: "#ff0000", values: [10] }] },
        },
        {
          id: "cht-bar-short",
          kind: "chart",
          x: 65,
          y: 70,
          width: 15,
          height: 18,
          color: "#000",
          chart: { type: "bar", categories: ["A", "B"], series: [{ name: "S", color: "#00ff00", values: [5] }] },
        },
        {
          id: "cht-col-short",
          kind: "chart",
          x: 82,
          y: 70,
          width: 15,
          height: 18,
          color: "#000",
          chart: { type: "column", categories: ["A", "B"], series: [{ name: "S", color: "#0000ff", values: [5] }] },
        },
      ],
    });
    expect(svg).toContain("Subtitle Body");
    expect(svg).toContain('text-anchor="end"');
    expect(svg).toContain('opacity="0.75"');
    expect(svg).toContain("Plain paragraph");
  });

  it("covers all Presentation facade (deck.ts) branches", async () => {
    const deck = Presentation.create({ title: "Deck Branches" });

    // setTitle whitespace fallback & toJSON without media
    deck.setTitle("   ");
    expect(deck.getTitle()).toBe("Untitled Presentation");
    expect(deck.toJSON().media).toBeUndefined();

    // addSlide with no args, with transition, and with explicit index
    deck.addSlide();
    deck.addSlide({
      title: "With Transition",
      body: "Body keyword match",
      notes: "Notes keyword match",
      transition: { type: "fade", durationMs: 300 },
    }, 0);
    expect(deck.getSlide(0)?.transition).toEqual({ type: "fade", durationMs: 300 });
    expect(deck.getSlide(999)).toBeUndefined();

    // addShape (auto-id, explicit id, error) & updateSlide/duplicateSlide/updateShape error paths
    const autoShp = deck.addShape(0, { kind: "rectangle", x: 10, y: 10, color: "#3370ff" });
    expect(autoShp.id).toMatch(/^shp-/);
    const paraShp = deck.addShape(0, {
      id: "para-1",
      kind: "text",
      x: 50,
      y: 10,
      color: "#111",
      paragraphs: [{ runs: [{ text: "Paragraph needle" }] }],
    });
    expect(paraShp.id).toBe("para-1");
    expect(() => deck.addShape(99, { kind: "rectangle", x: 0, y: 0, color: "#000" })).toThrow();
    expect(() => deck.updateSlide(99, { title: "X" })).toThrow();
    expect(() => deck.duplicateSlide(99)).toThrow();
    expect(() => deck.updateShape(99, "x", {})).toThrow();
    expect(() => deck.updateShape(0, "missing", {})).toThrow();

    // renderSvg out of range & renderAllSvg with explicit options
    expect(() => deck.renderSvg(99)).toThrow(RangeError);
    expect(deck.renderAllSvg({ theme: { primary: "#111" }, media: {} })).toHaveLength(deck.slideCount);

    // inspect(): default args, out-of-range slideIndex, standard detail with notes, undefined layout
    expect(deck.inspect().slides.some((s) => s.notesPreview === "Notes keyword match")).toBe(true);
    expect(deck.inspect({ slideIndex: 99 }).slides).toEqual([]);
    expect(deck.inspect({ slideIndex: -1 }).slides).toEqual([]);

    // query(): default empty options, body/notes/paragraphs matches, undefined layout
    expect(deck.query()).toHaveLength(deck.slideCount);
    expect(deck.query({ text: "Body keyword" })[0].matchedIn).toContain("body");
    expect(deck.query({ text: "Notes keyword" })[0].matchedIn).toContain("notes");
    expect(deck.query({ text: "Paragraph needle" })[0].shapeIds).toEqual(["para-1"]);

    const undefLayoutDeck = Presentation.fromPages([
      makePage({ id: 5, layout: undefined as unknown as "", title: "NoLayout" }),
    ]);
    expect(undefLayoutDeck.inspect().slides[0].layout).toBe("");
    expect(undefLayoutDeck.query({ layout: "" })).toHaveLength(1);

    // apply(): explicit index, auto-id shape, duplicate shape id, all error ops, non-Error throw, empty ops
    const res = deck.apply(
      [
        { op: "addSlide", index: 0, slide: { title: "AtZero" } },
        { op: "updateSlide", slideIndex: 99, patch: { title: "X" } },
        { op: "duplicateSlide", slideIndex: 99 },
        { op: "moveSlide", fromIndex: 99, toIndex: 0 },
        { op: "moveSlide", fromIndex: 0, toIndex: 99 },
        { op: "addShape", slideIndex: 99, shape: { kind: "rectangle", x: 0, y: 0, color: "#000" } },
        { op: "addShape", slideIndex: 0, shape: { kind: "ellipse", x: 5, y: 5, color: "#000" } },
        { op: "addShape", slideIndex: 0, shape: { id: "dup-id", kind: "ellipse", x: 5, y: 5, color: "#000" } },
        { op: "addShape", slideIndex: 0, shape: { id: "dup-id", kind: "ellipse", x: 5, y: 5, color: "#000" } },
        { op: "updateShape", slideIndex: 99, shapeId: "x", patch: {} },
        { op: "updateShape", slideIndex: 0, shapeId: "no-such", patch: {} },
        { op: "deleteShape", slideIndex: 0, shapeId: "no-such" },
        {
          op: "setTheme",
          get theme(): Record<string, string> {
            throw "raw-string-error";
          },
        } as unknown as SlideOp,
      ],
      { atomic: false },
    );
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("duplicate shape id"))).toBe(true);
    expect(res.errors.some((e) => e.includes("raw-string-error"))).toBe(true);
    expect(deck.apply([]).undoToken).toBeNull();

    // verify(): title overflow (layout="" & layout="title"), body overflow (layout="title"),
    // 3-hex & invalid colors, dark rgb <= 0.03928, empty text shape, paragraphs text shape, default width/height/fontSize
    const verifyDeck = Presentation.create({ initialSlide: false });
    verifyDeck.addSlide({
      title: "Very long slide title repeated many times to force overflow ".repeat(10),
      body: "Line\n".repeat(20),
      layout: "title",
      background: "#000",
      shapes: [
        { id: "t-empty", kind: "text", x: 10, y: 10, color: "" },
        { id: "t-invalid", kind: "text", x: 10, y: 35, color: "not-hex", text: "Hi" },
        { id: "t-3hex-dark", kind: "text", x: 10, y: 60, color: "#000", text: "Dark on dark" },
        {
          id: "t-para",
          kind: "text",
          x: 50,
          y: 10,
          width: 20,
          height: 8,
          color: "#fff",
          paragraphs: [{ runs: [{ text: "Paragraph overflow text ".repeat(20) }] }],
        },
      ],
    });
    verifyDeck.addSlide({
      title: "Very long standard slide title repeated many times ".repeat(10),
      body: "Short",
      layout: "",
      background: "#fff",
    });
    const diags = verifyDeck.verify();
    expect(diags.filter((d) => d.code === "TEXT_OVERFLOW").length).toBeGreaterThanOrEqual(4);
    expect(diags.some((d) => d.code === "LOW_CONTRAST" && d.shapeId === "t-3hex-dark")).toBe(true);

    // fromPptx with custom title option AND with blank slide 0 title fallback
    const blankPptx = exportSlidesToPptx([]);
    const { presentation: importedBlank } = await Presentation.fromPptx(blankPptx);
    expect(importedBlank.getTitle()).toBe("Imported Presentation");
    const { presentation: importedNamed } = await Presentation.fromPptx(blankPptx, { title: "Named Import" });
    expect(importedNamed.getTitle()).toBe("Named Import");

    // Undo stack cap > 100 in both pushUndo() and apply()
    const capDeck = Presentation.create({ title: "Cap" });
    for (let i = 0; i < 102; i++) capDeck.setTitle(`T${i}`);
    expect(capDeck.canUndo()).toBe(true);
    for (let i = 0; i < 102; i++) capDeck.apply([{ op: "setTheme", theme: { name: `Th${i}` } }]);
    expect(capDeck.canUndo()).toBe(true);
  });
});

describe("@jiange/slides-sdk PPTX exporter & importer full branch coverage", () => {
  it("covers all exporter shape kinds, layouts, rich paragraphs, tables, charts, and fallback options", async () => {
    // Empty pages -> default blank slide; whitespace title -> "Presentation"
    const emptyBytes = exportSlidesToPptx([], { title: "   " });
    const emptyParsed = await parsePptxToSlides(emptyBytes);
    expect(emptyParsed.pages).toHaveLength(1);

    const allGeomKinds: SlideShape["kind"][] = [
      "rectangle",
      "rounded-rectangle",
      "ellipse",
      "triangle",
      "right-triangle",
      "diamond",
      "pentagon",
      "hexagon",
      "star",
      "parallelogram",
      "trapezoid",
      "arrow-right",
    ];
    const geomShapes: SlideShape[] = allGeomKinds.map((kind, i) => ({
      id: `g-${i}`,
      kind,
      x: (i % 6) * 15,
      y: Math.floor(i / 6) * 20,
      color: i === 0 ? "invalid-color" : "#3370ff",
    }));

    const pages: PptxSlideInput[] = [
      {
        title: "All Shapes",
        body: "Has body",
        background: "#fff",
        layout: "blank-title",
        notes: "",
        hidden: false,
        shapes: [
          ...geomShapes,
          // Table without .table falls back to shapeKindToPrst -> null -> "rect"
          { id: "tbl-no-data", kind: "table", x: Number.NaN, y: 50, color: "#123456" },
          // Empty table & jagged headerless table
          { id: "tbl-empty", kind: "table", x: 10, y: 55, width: 20, height: 15, color: "#000", table: { rows: [] } },
          {
            id: "tbl-jagged",
            kind: "table",
            x: 35,
            y: 55,
            width: 20,
            height: 15,
            color: "#000",
            table: { headerRow: false, rows: [["A", "B"], ["C"]] },
          },
          // Chart without title and short series values
          {
            id: "cht-notitle",
            kind: "chart",
            x: 60,
            y: 55,
            width: 25,
            height: 15,
            color: "#00b42a",
            chart: { type: "bar", categories: ["X", "Y"], series: [{ name: "S1", values: [10] }] },
          },
          // line-arrow-filled
          { id: "ln-filled", kind: "line-arrow-filled", x: 10, y: 75, width: 20, height: 5, color: "#ff0000" },
          // Text right-aligned, text with undefined .text, rich paragraphs with empty runs / level / color / no align / no bullet
          { id: "txt-right", kind: "text", x: 35, y: 75, width: 20, height: 10, color: "#111", text: "Right", align: "right" },
          { id: "txt-undef", kind: "text", x: 58, y: 75, width: 15, height: 10, color: "#111" },
          {
            id: "txt-rich-edge",
            kind: "text",
            x: 75,
            y: 75,
            width: 20,
            height: 15,
            color: "#111",
            bold: true,
            paragraphs: [
              { level: 2, bullet: false, runs: [{ text: "Styled", fontSize: 16, color: "#ff0000" }, { text: "Plain", bold: false }] },
              { runs: [] },
            ],
          },
        ],
      },
      {
        title: "Blank Title",
        body: "Blank Body",
        background: "",
        layout: "blank",
        notes: "",
        hidden: false,
        shapes: [],
      },
      {
        title: "Undef layout & shapes",
        body: "",
        background: "",
        layout: undefined as unknown as "",
        notes: "",
        hidden: false,
        shapes: undefined as unknown as SlideShape[],
      },
    ];

    const bytes = exportSlidesToPptx(pages, { title: "Full Export" });
    const parsed = await parsePptxToSlides(bytes);
    expect(parsed.pages).toHaveLength(3);
    const rightTxt = parsed.pages[0].shapes.find((s) => s.kind === "text" && s.text === "Right");
    expect(rightTxt?.align).toBe("right");
    expect(parsed.pages[0].shapes.some((s) => s.kind === "line-arrow-filled")).toBe(true);
  });

  it("covers all OOXML preset shapes, connector kinds, placeholder merging, caps, truncation, and XML edge cases", async () => {
    const allPrsts = [
      "roundRect",
      "snip1Rect",
      "snip2SameRect",
      "round1Rect",
      "round2SameRect",
      "ellipse",
      "oval",
      "triangle",
      "rtTriangle",
      "diamond",
      "pentagon",
      "homePlate",
      "hexagon",
      "star4",
      "star5",
      "star6",
      "star7",
      "star8",
      "parallelogram",
      "trapezoid",
      "rightArrow",
      "chevron",
      "notchedRightArrow",
      "rect",
      "unknownPreset",
    ];

    const prstShapesXml = allPrsts
      .map(
        (prst, idx) =>
          `<p:sp><p:nvSpPr><p:cNvPr id="${10 + idx}" name="p${idx}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
          `<p:spPr><a:xfrm rot="bad"><a:off x="0" y="0"/><a:ext cx="1000000" cy="1000000"/></a:xfrm>` +
          `<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>` +
          (idx === 0
            ? `<a:ln><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></a:ln>`
            : idx === 1
              ? ``
              : `<a:solidFill><a:srgbClr val="3370FF"/></a:solidFill>`) +
          `</p:spPr></p:sp>`,
      )
      .join("");

    // Slide 1: all presets, stealth & head-only connectors, cxnSp without xfrm & without color, graphicFrame without tbl,
    // table with firstRow="true" and no fill, multiple ctrTitle/title/body placeholders + empty body,
    // non-txBox text without fill, text without color/fontSize/align, whitespace + <a:br/> + b="true", missing xfrm sp,
    // long title (>200 runes) & long body (>20000 bytes with CJK)
    const longTitle = "标".repeat(220);
    const longBody = "汉".repeat(7500); // 22500 UTF-8 bytes > 20000

    const slide1Xml =
      `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<p:cSld><p:spTree>` +
      // Two ctrTitle placeholders (tests title concatenation + truncation)
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name="CT1"/><p:cNvSpPr/><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:txBody><a:p> <a:r><a:rPr b="true"/><a:t>${longTitle}</a:t></a:r><a:br/><a:r><a:t>L2</a:t></a:r></a:p></p:txBody></p:sp>` +
      `<p:sp><p:nvSpPr><p:cNvPr id="3" name="CT2"/><p:cNvSpPr/><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>More</a:t></a:r></a:p></p:txBody></p:sp>` +
      // Two body placeholders + one empty body placeholder
      `<p:sp><p:nvSpPr><p:cNvPr id="4" name="B1"/><p:cNvSpPr/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${longBody}</a:t></a:r></a:p></p:txBody></p:sp>` +
      `<p:sp><p:nvSpPr><p:cNvPr id="5" name="B2"/><p:cNvSpPr/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Body2</a:t></a:r></a:p></p:txBody></p:sp>` +
      `<p:sp><p:nvSpPr><p:cNvPr id="6" name="B3"/><p:cNvSpPr/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr></p:sp>` +
      // All preset shapes
      prstShapesXml +
      // Non-txBox shape without fillColor but with text (triggers text box inference + default color/fontSize/align)
      `<p:sp><p:nvSpPr><p:cNvPr id="50" name="AutoTxt"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="1000000"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>Inferred Text</a:t></a:r></a:p></p:txBody></p:sp>` +
      // sp with missing xfrm and bad numeric xfrm
      `<p:sp><p:nvSpPr><p:cNvPr id="51" name="NoXfrm"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/></p:sp>` +
      `<p:sp><p:nvSpPr><p:cNvPr id="52" name="BadXfrm"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="nan" y="0"/><a:ext cx="1000" cy="1000"/></a:xfrm></p:spPr></p:sp>` +
      // Connectors: stealth, head-only arrow, no color, missing xfrm
      `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="60" name="C1"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="100000"/></a:xfrm><a:ln><a:tailEnd type="stealth"/></a:ln></p:spPr></p:cxnSp>` +
      `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="61" name="C2"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="100000"/></a:xfrm><a:ln><a:headEnd type="arrow"/></a:ln></p:spPr></p:cxnSp>` +
      `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="62" name="C3"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr/></p:cxnSp>` +
      // graphicFrame: table with firstRow="true" & no cell fill, plus non-table graphicFrame & bad xfrm graphicFrame
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="70" name="T1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="1000000"/></p:xfrm><a:graphic><a:graphicData><a:tbl><a:tblPr firstRow="true"/><a:tr><a:tc><a:txBody><a:p><a:r><a:t>H1</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>` +
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="71" name="SmartArt"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="1000000"/></p:xfrm><a:graphic><a:graphicData/></a:graphic></p:graphicFrame>` +
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="72" name="NoXfrmGF"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr></p:graphicFrame>` +
      `</p:spTree></p:cSld></p:sld>`;

    // Slide 2: two "title" placeholders + 101 shapes + 1 cxnSp after cap to hit MAX_IMPORT_SHAPES_PER_SLIDE cap
    const manyShapes = Array.from({ length: 101 }, (_, i) =>
      `<p:sp><p:nvSpPr><p:cNvPr id="${200 + i}" name="S${i}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="500000" cy="500000"/></a:xfrm><a:solidFill><a:srgbClr val="112233"/></a:solidFill></p:spPr></p:sp>`,
    ).join("");
    const slide2Xml =
      `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
      `<p:cSld><p:spTree>` +
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name="T1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Part1</a:t></a:r></a:p></p:txBody></p:sp>` +
      `<p:sp><p:nvSpPr><p:cNvPr id="3" name="T2"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Part2</a:t></a:r></a:p></p:txBody></p:sp>` +
      manyShapes +
      `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="400" name="CapCxn"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="500000" cy="500000"/></a:xfrm></p:spPr></p:cxnSp>` +
      `</p:spTree></p:cSld></p:sld>`;

    // Notes slide with sldNum, sldImg, and body placeholders
    const notes1Xml =
      `<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
      `<p:cSld><p:spTree>` +
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name="SN"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>1</a:t></a:r></a:p></p:txBody></p:sp>` +
      `<p:sp><p:nvSpPr><p:cNvPr id="3" name="SI"/><p:cNvSpPr/><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>img</a:t></a:r></a:p></p:txBody></p:sp>` +
      `<p:sp><p:nvSpPr><p:cNvPr id="4" name="NB"/><p:cNvSpPr/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Actual note</a:t></a:r></a:p></p:txBody></p:sp>` +
      `</p:spTree></p:cSld></p:notes>`;

    // Build archive with leading-slash root slide path (triggers resolveRelTarget "/" & relsPathFor slash < 0),
    // "./" segment, rel missing Type, rel missing Target, sldId missing r:id, and a corrupted media entry
    const zipBytes = createZip([
      {
        name: "ppt/presentation.xml",
        data: enc(
          `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
            `<p:sldIdLst><p:sldId id="255"/><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst>` +
            `</p:presentation>`,
        ),
      },
      {
        name: "ppt/_rels/presentation.xml.rels",
        data: enc(
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
            `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="/slide1.xml"/>` +
            `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="./slides/slide2.xml"/>` +
            `</Relationships>`,
        ),
      },
      { name: "slide1.xml", data: enc(slide1Xml) },
      {
        name: "_rels/slide1.xml.rels",
        data: enc(
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
            `<Relationship Id="rId1" Target="no-type.xml"/>` +
            `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide"/>` +
            `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="notes1.xml"/>` +
            `<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="bad.png"/>` +
            `</Relationships>`,
        ),
      },
      { name: "notes1.xml", data: enc(notes1Xml) },
      { name: "bad.png", data: new Uint8Array([1, 2, 3, 4]) },
      { name: "ppt/slides/slide2.xml", data: enc(slide2Xml) },
    ]);

    // Corrupt CRC of bad.png in-place so readZipEntry throws ZipError and parsePptxToSlides catches & continues
    const corrupted = new Uint8Array(zipBytes);
    const badNameBytes = enc("bad.png");
    let foundIdx = -1;
    for (let i = 0; i < corrupted.length - badNameBytes.length; i++) {
      let ok = true;
      for (let j = 0; j < badNameBytes.length; j++) {
        if (corrupted[i + j] !== badNameBytes[j]) {
          ok = false;
          break;
        }
      }
      if (ok && i >= 30 && corrupted[i - 30] === 0x50 && corrupted[i - 29] === 0x4b && corrupted[i - 28] === 0x03) {
        foundIdx = i + badNameBytes.length;
        break;
      }
    }
    expect(foundIdx).toBeGreaterThan(0);
    corrupted[foundIdx] ^= 0xff;

    const res = await parsePptxToSlides(corrupted);
    expect(res.pages).toHaveLength(2);
    expect(Array.from(res.pages[0].title).length).toBe(200);
    expect(enc(res.pages[0].body).length).toBeLessThanOrEqual(20000);
    expect(res.pages[0].notes).toBe("Actual note");
    expect(res.pages[0].shapes.some((s) => s.kind === "line-arrow-filled")).toBe(true);
    expect(res.pages[0].shapes.some((s) => s.kind === "line-arrow")).toBe(true);
    expect(res.pages[0].shapes.some((s) => s.kind === "text" && s.text === "Inferred Text")).toBe(true);
    expect(res.pages[0].shapes.some((s) => s.kind === "table" && s.table?.headerRow === true)).toBe(true);
    expect(res.pages[1].title).toBe("Part1 Part2");
    expect(res.pages[1].shapes).toHaveLength(100);
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it("covers fallback slide discovery, >100 slides cap, empty slide list error, and readXml/listZip error paths", async () => {
    // 1. Fallback slide discovery (empty sldIdLst) + numeric sorting (slide10 vs slide2)
    const fallbackZip = createZip([
      {
        name: "ppt/presentation.xml",
        data: enc(`<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst/></p:presentation>`),
      },
      {
        name: "ppt/slides/slide10.xml",
        data: enc(`<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Ten</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`),
      },
      {
        name: "ppt/slides/slide2.xml",
        data: enc(`<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Two</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`),
      },
    ]);
    const fallbackRes = await parsePptxToSlides(fallbackZip);
    expect(fallbackRes.pages.map((p) => p.title)).toEqual(["Two", "Ten"]);

    // 2. Presentation with 0 slides -> PptxError
    const noSlidesZip = createZip([
      {
        name: "ppt/presentation.xml",
        data: enc(`<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`),
      },
    ]);
    await expect(parsePptxToSlides(noSlidesZip)).rejects.toThrow("未包含任何幻灯片页面");

    // 3. > 100 slides -> truncated to 100 with warning
    const manyEntries = [
      {
        name: "ppt/presentation.xml",
        data: enc(`<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`),
      },
      ...Array.from({ length: 101 }, (_, i) => ({
        name: `ppt/slides/slide${i + 1}.xml`,
        data: enc(`<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sld>`),
      })),
    ];
    const cappedRes = await parsePptxToSlides(createZip(manyEntries));
    expect(cappedRes.pages).toHaveLength(100);
    expect(cappedRes.warnings.some((w) => w.includes("101"))).toBe(true);

    // 4. Malformed XML in presentation.xml -> XmlError wrapped in PptxError
    const badXmlZip = createZip([{ name: "ppt/presentation.xml", data: enc("<broken>") }]);
    await expect(parsePptxToSlides(badXmlZip)).rejects.toThrow(PptxError);

    // 5. Non-ZipError from listZip (null input) -> wrapped in PptxError
    await expect(parsePptxToSlides(null as unknown as Uint8Array)).rejects.toThrow("无法解析 PPTX 文件");

    // 6. Unexpected non-ZipError / non-XmlError inside readXml -> rethrown as-is
    const origDecode = TextDecoder.prototype.decode;
    const spy = vi.spyOn(TextDecoder.prototype, "decode").mockImplementation(function (this: TextDecoder, input, options) {
      const text = origDecode.call(this, input, options);
      if (text.startsWith("<p:presentation")) throw new Error("unexpected decoder failure");
      return text;
    });
    try {
      await expect(parsePptxToSlides(fallbackZip)).rejects.toThrow("unexpected decoder failure");
    } finally {
      spy.mockRestore();
    }
  });
});
