import { describe, expect, it } from "vitest";
import { createZip, listZip } from "@jiange/ooxml/zip";
import { exportSlidesToPptx, parsePptxToSlides, PptxError, type PptxSlideInput } from "../src/pptx.js";

describe("slides-sdk OOXML .pptx export and import", () => {
  it("round-trips multi-slide deck with layouts, backgrounds, hidden flag, shapes, lines, text boxes, and notes", async () => {
    const input: PptxSlideInput[] = [
      {
        title: "2026 年度产品规划",
        body: "聚焦实时协同与多端生态",
        background: "#1f2329",
        layout: "title",
        notes: "开场 2 分钟介绍整体节奏\n强调协同体验",
        hidden: false,
        shapes: [
          { id: "star-1", kind: "star", x: 74, y: 18, width: 14, height: 22, rotation: 25, color: "#3370ff" },
          { id: "line-1", kind: "line-double-arrow", x: 10, y: 80, width: 45, height: 8, rotation: 0, color: "#00b42a" },
        ],
      },
      {
        title: "核心指标拆解",
        body: "指标一：首屏加载\n指标二：协同延迟",
        background: "#f5f7fb",
        layout: "",
        notes: "内部评审备注",
        hidden: true,
        shapes: [
          {
            id: "txt-1",
            kind: "text",
            x: 52,
            y: 35,
            width: 38,
            height: 20,
            rotation: 0,
            color: "#f53f3f",
            text: "重点标注\nP99 < 80ms",
            fontSize: 28,
            bold: true,
            align: "center",
          },
          { id: "rr-1", kind: "rounded-rectangle", x: 12, y: 62, width: 24, height: 18, rotation: 180, color: "#722ed1" },
          { id: "ln-dot", kind: "line-dot", x: 40, y: 70, width: 20, height: 6, color: "#ff7d00" },
        ],
      },
      {
        title: "纯画布页",
        body: "",
        background: "",
        layout: "blank-title",
        notes: "",
        hidden: false,
        shapes: [],
      },
      {
        title: "",
        body: "",
        background: "#ffffff",
        layout: "blank",
        notes: "",
        hidden: false,
        shapes: [
          { id: "arrow-1", kind: "arrow-right", x: 20, y: 30, width: 30, height: 25, color: "#14c9c9" },
        ],
      },
    ];

    const bytes = exportSlidesToPptx(input, { title: "年度规划" });
    const zipEntries = listZip(bytes).map((e) => e.name);
    expect(zipEntries).toContain("[Content_Types].xml");
    expect(zipEntries).toContain("ppt/presentation.xml");
    expect(zipEntries).toContain("ppt/slides/slide1.xml");
    expect(zipEntries).toContain("ppt/slides/slide4.xml");
    expect(zipEntries).toContain("ppt/notesSlides/notesSlide1.xml");
    expect(zipEntries).toContain("ppt/notesSlides/notesSlide2.xml");
    expect(zipEntries).not.toContain("ppt/notesSlides/notesSlide3.xml");

    const parsed = await parsePptxToSlides(bytes);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.pages).toHaveLength(4);
    expect(parsed.shapeCount).toBe(6);

    // Slide 1
    expect(parsed.pages[0].title).toBe("2026 年度产品规划");
    expect(parsed.pages[0].body).toBe("聚焦实时协同与多端生态");
    expect(parsed.pages[0].background).toBe("#1f2329");
    expect(parsed.pages[0].layout).toBe("title");
    expect(parsed.pages[0].notes).toBe("开场 2 分钟介绍整体节奏\n强调协同体验");
    expect(parsed.pages[0].hidden).toBe(false);
    expect(parsed.pages[0].shapes).toHaveLength(2);
    expect(parsed.pages[0].shapes[0]).toMatchObject({ kind: "star", color: "#3370ff", rotation: 25 });
    expect(parsed.pages[0].shapes[1]).toMatchObject({ kind: "line-double-arrow", color: "#00b42a" });

    // Slide 2 (hidden + text box + rounded rect + line-dot)
    expect(parsed.pages[1].title).toBe("核心指标拆解");
    expect(parsed.pages[1].body).toBe("指标一：首屏加载\n指标二：协同延迟");
    expect(parsed.pages[1].background).toBe("#f5f7fb");
    expect(parsed.pages[1].layout).toBe("");
    expect(parsed.pages[1].hidden).toBe(true);
    expect(parsed.pages[1].notes).toBe("内部评审备注");
    expect(parsed.pages[1].shapes[0]).toMatchObject({
      kind: "text",
      text: "重点标注\nP99 < 80ms",
      fontSize: 28,
      bold: true,
      align: "center",
      color: "#f53f3f",
    });
    expect(parsed.pages[1].shapes[1]).toMatchObject({ kind: "rounded-rectangle", rotation: 180, color: "#722ed1" });
    expect(parsed.pages[1].shapes[2]).toMatchObject({ kind: "line-dot", color: "#ff7d00" });

    // Slide 3 (blank-title)
    expect(parsed.pages[2].layout).toBe("blank-title");
    expect(parsed.pages[2].title).toBe("纯画布页");

    // Slide 4 (blank)
    expect(parsed.pages[3].layout).toBe("blank");
    expect(parsed.pages[3].shapes[0]).toMatchObject({ kind: "arrow-right", color: "#14c9c9" });
  });

  it("parses external-style 4:3 PowerPoint archive and warns on skipped pictures", async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const bytes = createZip([
      {
        name: "ppt/presentation.xml",
        data: enc(
          `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
            `<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>` +
            `<p:sldSz cx="9144000" cy="6858000" type="screen4x3"/>` +
            `</p:presentation>`,
        ),
      },
      {
        name: "ppt/_rels/presentation.xml.rels",
        data: enc(
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
            `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>` +
            `</Relationships>`,
        ),
      },
      {
        name: "ppt/slides/slide1.xml",
        data: enc(
          `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
            `<p:cSld><p:spTree>` +
            `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>External Slide</a:t></a:r></a:p></p:txBody></p:sp>` +
            `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Slide Num"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>1</a:t></a:r></a:p></p:txBody></p:sp>` +
            `<p:pic><p:nvPicPr><p:cNvPr id="4" name="Pic"/></p:nvPicPr></p:pic>` +
            `</p:spTree></p:cSld></p:sld>`,
        ),
      },
    ]);

    const res = await parsePptxToSlides(bytes);
    expect(res.pages).toHaveLength(1);
    expect(res.pages[0].title).toBe("External Slide");
    expect(res.pages[0].body).toBe(""); // sldNum ignored
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("跳过 1 个");
  });

  it("rejects corrupt or non-pptx files cleanly with PptxError", async () => {
    await expect(parsePptxToSlides(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(PptxError);
    const noPres = createZip([{ name: "hello.txt", data: new TextEncoder().encode("hi") }]);
    await expect(parsePptxToSlides(noPres)).rejects.toThrow(PptxError);
  });
});
