import { describe, expect, it } from "vitest";
import { listZip } from "@jiange/ooxml/zip";
import { Presentation } from "../src/deck.js";
import { createSlidesTools } from "../src/ai-tools.js";
import { exportSlidesToPptxAsync, parsePptxToSlides } from "../src/pptx.js";
import { renderDeckToSvg, renderSlideToSvg } from "../src/svg.js";

const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
]);

describe("slides-sdk Presentation Facade, SVG renderer, DEFLATE PPTX & AI tools", () => {
  it("supports CRUD, atomic apply with dryRun/rollback, undo/redo, inspect, and query", () => {
    const deck = Presentation.create({ title: "Q4 Strategy" });
    expect(deck.slideCount).toBe(1);
    expect(deck.getTitle()).toBe("Q4 Strategy");

    // Dry run should not mutate state
    const dry = deck.apply(
      [{ op: "addSlide", slide: { title: "Dry Slide", body: "Should not persist" } }],
      { dryRun: true },
    );
    expect(dry.ok).toBe(true);
    expect(dry.applied).toBe(1);
    expect(dry.undoToken).toBeNull();
    expect(deck.slideCount).toBe(1);

    // Atomic batch with error rolls back cleanly
    const failed = deck.apply([
      { op: "addSlide", slide: { title: "Temp" } },
      { op: "deleteShape", slideIndex: 99, shapeId: "missing" },
    ]);
    expect(failed.ok).toBe(false);
    expect(failed.applied).toBe(0);
    expect(deck.slideCount).toBe(1);

    // Valid batch apply
    const applied = deck.apply([
      { op: "addSlide", slide: { title: "Metrics", body: "Revenue +42%", notes: "Highlight ARR" } },
      {
        op: "addShape",
        slideIndex: 1,
        shape: {
          id: "tbl-1",
          kind: "table",
          x: 10,
          y: 45,
          width: 40,
          height: 30,
          color: "#3370ff",
          table: {
            headerRow: true,
            rows: [
              ["Region", "ARR"],
              ["APAC", "$4.2M"],
              ["EMEA", "$3.1M"],
            ],
          },
        },
      },
      {
        op: "addShape",
        slideIndex: 1,
        shape: {
          id: "cht-1",
          kind: "chart",
          x: 54,
          y: 45,
          width: 38,
          height: 30,
          color: "#00b42a",
          chart: {
            type: "column",
            title: "Growth",
            categories: ["Q1", "Q2", "Q3"],
            series: [{ name: "ARR", values: [20, 35, 52] }],
          },
        },
      },
      { op: "setTheme", theme: { primary: "#2563eb" } },
    ]);
    expect(applied.ok).toBe(true);
    expect(applied.applied).toBe(4);
    expect(applied.undoToken).toBeTruthy();
    expect(deck.slideCount).toBe(2);
    expect(deck.getTheme().primary).toBe("#2563eb");

    // Inspect summary vs full & token budget
    const full = deck.inspect({ detail: "full", slideIndex: 1 });
    expect(full.slides).toHaveLength(1);
    expect(full.slides[0].shapes).toHaveLength(2);
    const tiny = deck.inspect({ detail: "full", maxTokens: 50 });
    expect(tiny.truncated).toBe(true);

    // Query
    expect(deck.query({ text: "APAC" })).toHaveLength(1);
    expect(deck.query({ shapeKind: "chart" })[0].shapeIds).toEqual(["cht-1"]);
    expect(deck.query({ layout: "title" })).toHaveLength(1);

    // Duplicate, move, update, delete + undo/redo
    deck.duplicateSlide(1);
    expect(deck.slideCount).toBe(3);
    expect(deck.moveSlide(2, 0)).toBe(true);
    deck.updateSlide(0, { hidden: true });
    expect(deck.query({ hidden: true })).toHaveLength(1);
    deck.updateShape(0, "tbl-1", { x: 12 });
    expect(deck.deleteShape(0, "tbl-1")).toBe(true);
    expect(deck.deleteSlide(0)).toBe(true);
    expect(deck.slideCount).toBe(2);

    expect(deck.undo()).toBe(true);
    expect(deck.slideCount).toBe(3);
    expect(deck.redo()).toBe(true);
    expect(deck.slideCount).toBe(2);
  });

  it("detects visual layout issues in verify() (empty, overflow, overlap, out-of-bounds, contrast, media)", () => {
    const emptyDeck = Presentation.create({ initialSlide: false });
    expect(emptyDeck.verify()[0].code).toBe("EMPTY_DECK");

    const deck = Presentation.create({ title: "Visual Audit" });
    deck.addSlide({ title: "", body: "" });
    deck.addSlide({
      title: "Visual Audit Slide",
      body: "Line\n".repeat(40),
      background: "#ffffff",
      shapes: [
        {
          id: "low-contrast",
          kind: "text",
          x: 10,
          y: 20,
          width: 30,
          height: 15,
          color: "#eeeeee",
          text: "Too faint ".repeat(30),
          fontSize: 28,
        },
        {
          id: "overlap-box",
          kind: "rectangle",
          x: 12,
          y: 22,
          width: 30,
          height: 15,
          color: "#3370ff",
        },
        {
          id: "oob-box",
          kind: "ellipse",
          x: 90,
          y: 90,
          width: 20,
          height: 20,
          color: "#ff7d00",
        },
        {
          id: "missing-img",
          kind: "image",
          x: 60,
          y: 10,
          width: 20,
          height: 20,
          color: "#ffffff",
          mediaId: "not-registered",
        },
      ],
    });

    const codes = new Set(deck.verify().map((d) => d.code));
    expect(codes.has("EMPTY_SLIDE")).toBe(true);
    expect(codes.has("TEXT_OVERFLOW")).toBe(true);
    expect(codes.has("LOW_CONTRAST")).toBe(true);
    expect(codes.has("SHAPE_OVERLAP")).toBe(true);
    expect(codes.has("OUT_OF_BOUNDS")).toBe(true);
    expect(codes.has("MISSING_MEDIA")).toBe(true);
  });

  it("renders all shape kinds, tables, charts (bar/line/pie/column), and embedded images to SVG", () => {
    const deck = Presentation.create({ title: "SVG Showcase" });
    deck.addMedia({ id: "logo", mimeType: "image/png", data: TINY_PNG, name: "logo.png" });
    deck.addSlide({
      title: "Shapes & Data",
      body: "Summary bullet",
      background: "#0f172a",
      shapes: [
        { id: "s1", kind: "rectangle", x: 5, y: 20, width: 10, height: 10, color: "#3370ff" },
        { id: "s2", kind: "rounded-rectangle", x: 16, y: 20, width: 10, height: 10, color: "#00b42a" },
        { id: "s3", kind: "ellipse", x: 27, y: 20, width: 10, height: 10, color: "#ff7d00" },
        { id: "s4", kind: "triangle", x: 38, y: 20, width: 10, height: 10, color: "#f53f3f" },
        { id: "s5", kind: "right-triangle", x: 49, y: 20, width: 10, height: 10, color: "#722ed1" },
        { id: "s6", kind: "diamond", x: 60, y: 20, width: 10, height: 10, color: "#14c9c9" },
        { id: "s7", kind: "pentagon", x: 71, y: 20, width: 10, height: 10, color: "#2563eb" },
        { id: "s8", kind: "hexagon", x: 82, y: 20, width: 10, height: 10, color: "#10b981" },
        { id: "s9", kind: "star", x: 5, y: 35, width: 10, height: 10, color: "#f59e0b", rotation: 15 },
        { id: "s10", kind: "parallelogram", x: 16, y: 35, width: 10, height: 10, color: "#6366f1" },
        { id: "s11", kind: "trapezoid", x: 27, y: 35, width: 10, height: 10, color: "#ec4899" },
        { id: "s12", kind: "arrow-right", x: 38, y: 35, width: 10, height: 10, color: "#14b8a6" },
        { id: "s13", kind: "line-double-arrow", x: 50, y: 38, width: 18, height: 5, color: "#ffffff" },
        {
          id: "s14",
          kind: "text",
          x: 5,
          y: 50,
          width: 22,
          height: 18,
          color: "#ffffff",
          paragraphs: [{ bullet: true, runs: [{ text: "Rich bullet", bold: true }] }],
        },
        {
          id: "s15",
          kind: "chart",
          x: 30,
          y: 50,
          width: 20,
          height: 20,
          color: "#3370ff",
          chart: { type: "pie", title: "Share", categories: ["A", "B"], series: [{ name: "S", values: [60, 40] }] },
        },
        {
          id: "s16",
          kind: "chart",
          x: 52,
          y: 50,
          width: 20,
          height: 20,
          color: "#3370ff",
          chart: { type: "line", categories: ["Jan", "Feb"], series: [{ name: "Trend", values: [10, 25] }] },
        },
        {
          id: "s17",
          kind: "chart",
          x: 74,
          y: 50,
          width: 20,
          height: 20,
          color: "#3370ff",
          chart: { type: "bar", categories: ["X", "Y"], series: [{ name: "Bar", values: [12, 18] }] },
        },
        { id: "s18", kind: "image", x: 75, y: 74, width: 15, height: 15, color: "#ffffff", mediaId: "logo" },
      ],
    });

    const svgs = deck.renderAllSvg();
    expect(svgs).toHaveLength(2);
    expect(svgs[1]).toContain("<svg ");
    expect(svgs[1]).toContain("data:image/png;base64,");
    expect(svgs[1]).toContain('data-kind="chart"');
    expect(renderDeckToSvg(deck.getPages())).toHaveLength(2);
    expect(renderSlideToSvg(deck.getSlide(0)!)).toContain("SVG Showcase");
  });

  it("round-trips tables, embedded PNG images, and rich paragraphs via DEFLATE exportSlidesToPptxAsync", async () => {
    const deck = Presentation.create({ title: "OOXML Full" });
    deck.addMedia({ id: "img-1", mimeType: "image/png", data: TINY_PNG, name: "pixel.png" });
    deck.addSlide({
      title: "Data & Media",
      body: "Details",
      shapes: [
        {
          id: "t1",
          kind: "table",
          x: 8,
          y: 30,
          width: 45,
          height: 35,
          color: "#3370ff",
          table: {
            headerRow: true,
            headerFill: "#2563eb",
            rows: [
              ["Metric", "Value"],
              ["Latency", "4.2ms"],
            ],
          },
        },
        {
          id: "p1",
          kind: "image",
          x: 60,
          y: 30,
          width: 25,
          height: 30,
          color: "#ffffff",
          mediaId: "img-1",
        },
        {
          id: "txt-rich",
          kind: "text",
          x: 8,
          y: 72,
          width: 50,
          height: 16,
          color: "#1f2329",
          paragraphs: [
            { bullet: true, align: "left", runs: [{ text: "Key point", bold: true, italic: true, underline: true }] },
          ],
        },
      ],
    });

    const storeBytes = deck.toPptx();
    const deflateBytes = await deck.toPptxAsync();
    expect(deflateBytes.length).toBeLessThan(storeBytes.length);

    const entries = listZip(deflateBytes).map((e) => e.name);
    expect(entries).toContain("ppt/media/image1.png");

    const { presentation: reloaded, warnings } = await Presentation.fromPptx(deflateBytes);
    expect(warnings).toEqual([]);
    expect(reloaded.slideCount).toBe(2);
    const s2 = reloaded.getSlide(1)!;
    const tbl = s2.shapes.find((s) => s.kind === "table");
    const img = s2.shapes.find((s) => s.kind === "image");
    expect(tbl?.table?.rows).toEqual([
      ["Metric", "Value"],
      ["Latency", "4.2ms"],
    ]);
    expect(img?.mediaId).toBeTruthy();
    expect(reloaded.getMedia()[img!.mediaId!].data).toEqual(TINY_PNG);

    // Direct async helper sanity
    const rawAsync = await exportSlidesToPptxAsync(deck.getPages(), { media: deck.getMedia() });
    const parsed = await parsePptxToSlides(rawAsync);
    expect(parsed.pages).toHaveLength(2);
  });

  it("exposes AI Tool definitions and executes all tools", () => {
    const deck = Presentation.create({ title: "AI Deck" });
    const runtime = createSlidesTools(deck);
    expect(runtime.tools.map((t) => t.name)).toContain("slides_verify");

    const applyRes = runtime.execute("slides_apply", {
      ops: [{ op: "addSlide", slide: { title: "Generated Slide", body: "By AI" } }],
    }) as { ok: boolean; applied: number };
    expect(applyRes.ok).toBe(true);

    const inspected = runtime.execute("slides_inspect", { detail: "summary" }) as { slideCount: number };
    expect(inspected.slideCount).toBe(2);

    const queried = runtime.execute("slides_query", { text: "Generated" }) as unknown[];
    expect(queried).toHaveLength(1);

    const verified = runtime.execute("slides_verify") as unknown[];
    expect(Array.isArray(verified)).toBe(true);

    const svgRes = runtime.execute("slides_render_svg", { slideIndex: 1 }) as { svg: string };
    expect(svgRes.svg).toContain("Generated Slide");

    const undone = runtime.execute("slides_undo") as { undone: boolean };
    expect(undone.undone).toBe(true);
    const redone = runtime.execute("slides_redo") as { redone: boolean };
    expect(redone.redone).toBe(true);
    expect(() => runtime.execute("unknown_tool")).toThrow();

    // Exercise explicit optional args for branch coverage
    const inspectedFull = runtime.execute("slides_inspect", { detail: "full", maxTokens: 500, slideIndex: 0 }) as { slideCount: number };
    expect(inspectedFull.slideCount).toBe(2);
    const queriedFiltered = runtime.execute("slides_query", { layout: "title", hidden: false, shapeKind: "rectangle" }) as unknown[];
    expect(Array.isArray(queriedFiltered)).toBe(true);
    const dryApply = runtime.execute("slides_apply", { ops: [{ op: "deleteSlide", slideIndex: 99 }], dryRun: true, atomic: false, actor: "agent" }) as { ok: boolean };
    expect(dryApply.ok).toBe(false);
    const sizedSvg = runtime.execute("slides_render_svg", { slideIndex: 0, width: 640, height: 360 }) as { svg: string };
    expect(sizedSvg.svg).toContain('width="640"');
  });

  it("covers edge branches: column chart & table SVG, 3-hex colors, CJK wrap, fromPages, toJSON, non-atomic apply, and multi-mime media", async () => {
    const base = Presentation.create({ title: "Edge", theme: { background: "#fff" } });
    expect(base.undo()).toBe(false);
    expect(base.redo()).toBe(false);
    base.setTitle("Renamed");
    base.setTheme({ accent: "#09f" });
    base.addMedia({ id: "jpg", mimeType: "image/jpeg", data: new Uint8Array([0xff, 0xd8, 0xff]) });
    base.addMedia({ id: "svg", mimeType: "image/svg+xml", data: new TextEncoder().encode("<svg/>") });
    base.addMedia({ id: "webp", mimeType: "image/webp", data: new Uint8Array([0x52, 0x49, 0x46, 0x46]) });
    base.addSlide({
      title: "中文长标题换行测试用于覆盖自动折行逻辑",
      body: "第一行很长的中文内容用于验证文本渲染与换行计算\n\n第三行",
      background: "#000",
      shapes: [
        { id: "tbl", kind: "table", x: 5, y: 20, width: 40, height: 30, color: "#3370ff", table: { headerRow: true, rows: [["A", "B"], ["1", "2"]] } },
        { id: "col", kind: "chart", x: 50, y: 20, width: 40, height: 30, color: "#00b42a", chart: { type: "column", title: "Col", categories: ["X", "Y"], series: [{ name: "S", values: [10, 20] }] } },
        { id: "img-missing", kind: "image", x: 5, y: 55, width: 15, height: 15, color: "#fff" },
        { id: "img-jpg", kind: "image", x: 25, y: 55, width: 15, height: 15, color: "#fff", mediaId: "jpg" },
        { id: "img-svg", kind: "image", x: 45, y: 55, width: 15, height: 15, color: "#fff", mediaId: "svg" },
        { id: "img-webp", kind: "image", x: 65, y: 55, width: 15, height: 15, color: "#fff", mediaId: "webp" },
        { id: "ln1", kind: "line", x: 5, y: 80, width: 20, height: 4, color: "#fff" },
        { id: "ln2", kind: "line-dot", x: 30, y: 80, width: 20, height: 4, color: "#fff" },
        { id: "ln3", kind: "line-arrow", x: 55, y: 80, width: 20, height: 4, color: "#fff" },
      ],
    });
    const svg = base.renderSvg(1);
    expect(svg).toContain('data-kind="table"');
    expect(svg).toContain('data-kind="chart"');
    expect(svg).toContain("stroke-dasharray");

    const json = base.toJSON();
    const cloned = Presentation.fromPages(json.pages, { title: json.title, theme: json.theme, media: json.media });
    expect(cloned.slideCount).toBe(2);

    // Duplicate shape ID diagnostic via fromPages
    const dupPages = cloned.getPages();
    dupPages[1].shapes.push({ id: "tbl", kind: "rectangle", x: 1, y: 1, width: 5, height: 5, color: "#3370ff" });
    const dupDeck = Presentation.fromPages(dupPages);
    expect(dupDeck.verify().some((d) => d.code === "DUPLICATE_SHAPE_ID")).toBe(true);

    // Export PPTX with chart + jpg/svg/webp media
    const pptx = await base.toPptxAsync();
    const parsed = await parsePptxToSlides(pptx);
    expect(parsed.pages).toHaveLength(2);
    expect(Object.keys(parsed.media ?? {}).length).toBeGreaterThanOrEqual(3);
  });
});
