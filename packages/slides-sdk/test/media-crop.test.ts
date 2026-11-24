import { describe, expect, it } from "vitest";
import { exportSlidesToPptx, parsePptxToSlides } from "../src/pptx.js";
import { renderSlideToSvg } from "../src/svg.js";
import type { SlideMediaAsset, SlideShape } from "../src/model.js";

const SAMPLE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
});
