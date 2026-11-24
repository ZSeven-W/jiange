import { describe, expect, it } from "vitest";
import { createZip, listZip, readZipEntry } from "@jiange/ooxml/zip";
import { Presentation } from "../src/deck.js";
import { exportSlidesToPptx, parsePptxToSlides } from "../src/pptx.js";
import { renderSlideToSvg } from "../src/svg.js";
import type { SlideMediaAsset, SlideShape } from "../src/model.js";

const SAMPLE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const enc = (s: string) => new TextEncoder().encode(s);

describe("slides-sdk video/audio shapes and image cropping", () => {
  it("renders video, audio, and cropped image shapes cleanly to SVG", () => {
    const media: Record<string, SlideMediaAsset> = {
      "img-1": { id: "img-1", mimeType: "image/png", data: SAMPLE_PNG, name: "demo.png" },
    };
    const shapes: SlideShape[] = [
      {
        id: "vid-1",
        kind: "video",
        x: 10,
        y: 15,
        width: 40,
        height: 35,
        color: "#3370ff",
        mediaUrl: "https://cdn.example.com/demo.mp4",
        posterUrl: "https://cdn.example.com/poster.jpg",
        autoplay: false,
        loop: true,
      },
      {
        id: "aud-1",
        kind: "audio",
        x: 10,
        y: 60,
        width: 40,
        height: 12,
        color: "#00b42a",
        mediaUrl: "/api/files/42",
        loop: false,
      },
      {
        id: "img-crop-1",
        kind: "image",
        x: 55,
        y: 15,
        width: 35,
        height: 45,
        color: "#ffffff",
        mediaId: "img-1",
        crop: { x: 0.25, y: 0.1, w: 0.5, h: 0.8 },
      },
    ];

    const svg = renderSlideToSvg(
      { title: "Media Slide", body: "", background: "#ffffff", layout: "", shapes },
      { media },
    );

    expect(svg).toContain('data-kind="video"');
    expect(svg).toContain("https://cdn.example.com/demo.mp4");
    expect(svg).toContain('data-kind="audio"');
    expect(svg).toContain("/api/files/42");
    expect(svg).toContain('overflow="hidden"');
    expect(svg).toContain('preserveAspectRatio="none"');
  });

  it("exports video/audio placeholders and round-trips image crop through OOXML srcRect", async () => {
    const media: Record<string, SlideMediaAsset> = {
      "img-1": { id: "img-1", mimeType: "image/png", data: SAMPLE_PNG, name: "demo.png" },
    };
    const bytes = exportSlidesToPptx(
      [
        {
          title: "Media Export",
          body: "",
          background: "#ffffff",
          layout: "",
          notes: "",
          hidden: false,
          shapes: [
            {
              id: "vid-1",
              kind: "video",
              x: 10,
              y: 20,
              width: 40,
              height: 30,
              color: "#3370ff",
              mediaUrl: "https://cdn.example.com/clip.mp4",
            },
            {
              id: "aud-1",
              kind: "audio",
              x: 10,
              y: 60,
              width: 40,
              height: 12,
              color: "#3370ff",
              mediaUrl: "https://cdn.example.com/talk.mp3",
            },
            {
              id: "img-crop-1",
              kind: "image",
              x: 55,
              y: 20,
              width: 35,
              height: 40,
              color: "#ffffff",
              mediaId: "img-1",
              crop: { x: 0.1, y: 0.2, w: 0.6, h: 0.5 },
            },
          ],
        },
      ],
      { title: "Media Deck", media },
    );

    const parsed = await parsePptxToSlides(bytes);
    expect(parsed.pages).toHaveLength(1);
    const imgShape = parsed.pages[0].shapes.find((s) => s.kind === "image");
    expect(imgShape).toBeDefined();
    expect(imgShape?.crop).toEqual({ x: 0.1, y: 0.2, w: 0.6, h: 0.5 });
    expect(parsed.pages[0].shapes.length).toBeGreaterThanOrEqual(3);
  });

  it("handles default video/audio labels and single-axis or full-frame image crops in SVG and PPTX", async () => {
    const media: Record<string, SlideMediaAsset> = {
      "img-1": { id: "img-1", mimeType: "image/png", data: SAMPLE_PNG, name: "demo.png" },
    };
    const shapes: SlideShape[] = [
      { id: "vid-bare", kind: "video", x: 5, y: 5, width: 20, height: 15, color: "#3370ff" },
      { id: "aud-bare", kind: "audio", x: 30, y: 5, width: 20, height: 10, color: "#00b42a" },
      {
        id: "img-crop-y",
        kind: "image",
        x: 5,
        y: 25,
        width: 20,
        height: 20,
        color: "#ffffff",
        mediaId: "img-1",
        crop: { x: 0, y: 0.2, w: 1, h: 0.8 },
      },
      {
        id: "img-crop-w",
        kind: "image",
        x: 30,
        y: 25,
        width: 20,
        height: 20,
        color: "#ffffff",
        mediaId: "img-1",
        crop: { x: 0, y: 0, w: 0.5, h: 1 },
      },
      {
        id: "img-crop-h",
        kind: "image",
        x: 55,
        y: 25,
        width: 20,
        height: 20,
        color: "#ffffff",
        mediaId: "img-1",
        crop: { x: 0, y: 0, w: 1, h: 0.5 },
      },
      {
        id: "img-crop-noop",
        kind: "image",
        x: 5,
        y: 55,
        width: 20,
        height: 20,
        color: "#ffffff",
        mediaId: "img-1",
        crop: { x: 0, y: 0, w: 1, h: 1 },
      },
    ];

    const svg = renderSlideToSvg(
      { title: "Crop Edges", body: "", background: "#ffffff", layout: "", shapes },
      { media },
    );
    expect(svg).toContain(">Video<");
    expect(svg).toContain(">Audio<");
    // Three cropped shapes emit overflow="hidden" nested SVGs; full-frame crop renders uncropped image
    expect(svg.match(/overflow="hidden"/g)).toHaveLength(3);
    expect(svg).toContain('preserveAspectRatio="xMidYMid meet"');

    const bytes = exportSlidesToPptx(
      [
        {
          title: "Crop Edges",
          body: "",
          background: "#ffffff",
          layout: "",
          notes: "",
          hidden: false,
          shapes,
        },
      ],
      { title: "Edge Deck", media },
    );
    const slideEntry = listZip(bytes).find((e) => e.name === "ppt/slides/slide1.xml");
    expect(slideEntry).toBeDefined();
    const slideXml = new TextDecoder().decode(await readZipEntry(bytes, slideEntry!, 1_000_000));
    expect(slideXml).toContain("<a:t>[Video]</a:t>");
    expect(slideXml).toContain("<a:t>[Audio]</a:t>");
    expect(slideXml.match(/<a:srcRect\b/g)).toHaveLength(3);

    const parsed = await parsePptxToSlides(bytes);
    const importedImages = parsed.pages[0].shapes.filter((s) => s.kind === "image");
    expect(importedImages.map((s) => s.crop)).toEqual([
      { x: 0, y: 0.2, w: 1, h: 0.8 },
      { x: 0, y: 0, w: 0.5, h: 1 },
      { x: 0, y: 0, w: 1, h: 0.5 },
      undefined,
    ]);
  });

  it("parses partial and invalid OOXML srcRect attributes safely", async () => {
    const picXml = (id: number, name: string, srcRectXml: string) =>
      `<p:pic>` +
      `<p:nvPicPr><p:cNvPr id="${id}" name="${name}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
      `<p:blipFill><a:blip r:embed="rIdImg1"/>${srcRectXml}<a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
      `<p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="1828800" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
      `</p:pic>`;

    const bytes = createZip([
      {
        name: "ppt/presentation.xml",
        data: enc(
          `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
            `<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>` +
            `<p:sldSz cx="12192000" cy="6858000"/>` +
            `</p:presentation>`,
        ),
      },
      {
        name: "ppt/_rels/presentation.xml.rels",
        data: enc(
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
            `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>` +
            `</Relationships>`,
        ),
      },
      {
        name: "ppt/slides/_rels/slide1.xml.rels",
        data: enc(
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
            `<Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>` +
            `</Relationships>`,
        ),
      },
      { name: "ppt/media/image1.png", data: SAMPLE_PNG },
      {
        name: "ppt/slides/slide1.xml",
        data: enc(
          `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
            `<p:cSld><p:spTree>` +
            picXml(2, "TopOnly", `<a:srcRect t="20000"/>`) +
            picXml(3, "RightOnly", `<a:srcRect r="25000"/>`) +
            picXml(4, "BottomOnly", `<a:srcRect b="30000"/>`) +
            picXml(5, "InvalidAttrs", `<a:srcRect l="bad" t="0" r="" b="NaN"/>`) +
            picXml(6, "EmptySrcRect", `<a:srcRect/>`) +
            `</p:spTree></p:cSld></p:sld>`,
        ),
      },
    ]);

    const parsed = await parsePptxToSlides(bytes);
    const images = parsed.pages[0].shapes.filter((s) => s.kind === "image");
    expect(images).toHaveLength(5);
    expect(images.map((s) => s.crop)).toEqual([
      { x: 0, y: 0.2, w: 1, h: 0.8 },
      { x: 0, y: 0, w: 0.75, h: 1 },
      { x: 0, y: 0, w: 1, h: 0.7 },
      undefined,
      undefined,
    ]);
  });

  it("deep-clones image crop rectangles in Presentation snapshots", () => {
    const deck = Presentation.create({ title: "Crop Deck" });
    deck.addShape(0, {
      id: "cropped-img",
      kind: "image",
      x: 10,
      y: 10,
      width: 40,
      height: 40,
      color: "#ffffff",
      mediaId: "img-1",
      crop: { x: 0.1, y: 0.2, w: 0.6, h: 0.5 },
    });

    const pages = deck.getPages();
    const shape = pages[0].shapes.find((s) => s.id === "cropped-img");
    expect(shape?.crop).toEqual({ x: 0.1, y: 0.2, w: 0.6, h: 0.5 });

    // Mutating returned crop must not affect internal deck state
    shape!.crop!.x = 0.9;
    expect(deck.getPages()[0].shapes.find((s) => s.id === "cropped-img")?.crop?.x).toBe(0.1);
  });
});
