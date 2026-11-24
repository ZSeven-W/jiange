import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SlideShape } from "@/lib/api";
import { sameSlideContent, type SlideContent } from "./slides-draft";
import { slideImageCropStyle, SlideShapes } from "./slides-shapes";
import { SLIDE_CROP_PRESETS, SlideShapeControls, updateImageCropField } from "./slides-shape-controls";

const baseContent = (shapes: SlideShape[]): SlideContent => ({
  title: "Demo",
  body: "",
  background: "#ffffff",
  layout: "",
  notes: "",
  shapes,
});

describe("slides video/audio shapes and image cropping", () => {
  it("detects mediaUrl, posterUrl, autoplay, loop, and crop edits in sameSlideContent", () => {
    const vid: SlideShape = {
      id: "v1",
      kind: "video",
      x: 10,
      y: 10,
      width: 40,
      height: 30,
      color: "#1f2329",
      mediaUrl: "https://cdn.example.com/v1.mp4",
      posterUrl: "https://cdn.example.com/p1.jpg",
      autoplay: false,
      loop: false,
    };
    expect(sameSlideContent(baseContent([vid]), baseContent([{ ...vid }]))).toBe(true);
    expect(sameSlideContent(baseContent([vid]), baseContent([{ ...vid, mediaUrl: "https://cdn.example.com/v2.mp4" }]))).toBe(false);
    expect(sameSlideContent(baseContent([vid]), baseContent([{ ...vid, posterUrl: "https://cdn.example.com/p2.jpg" }]))).toBe(false);
    expect(sameSlideContent(baseContent([vid]), baseContent([{ ...vid, autoplay: true }]))).toBe(false);
    expect(sameSlideContent(baseContent([vid]), baseContent([{ ...vid, loop: true }]))).toBe(false);

    const img: SlideShape = {
      id: "i1",
      kind: "image",
      x: 10,
      y: 10,
      width: 35,
      height: 35,
      color: "#ffffff",
      fileId: 5,
      crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
    };
    expect(sameSlideContent(baseContent([img]), baseContent([{ ...img, crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } }]))).toBe(true);
    expect(sameSlideContent(baseContent([img]), baseContent([{ ...img, crop: { x: 0.2, y: 0.1, w: 0.6, h: 0.8 } }]))).toBe(false);
    expect(sameSlideContent(baseContent([img]), baseContent([{ ...img, crop: undefined }]))).toBe(false);
  });

  it("computes accurate CSS crop math and renders video, audio, and cropped images in SlideShapes", () => {
    expect(slideImageCropStyle(undefined)).toBeNull();
    expect(slideImageCropStyle({ x: 0, y: 0, w: 1, h: 1 })).toBeNull();
    const style = slideImageCropStyle({ x: 0.25, y: 0.2, w: 0.5, h: 0.5 });
    expect(style).toMatchObject({
      width: "200.0000%",
      height: "200.0000%",
      left: "-50.0000%",
      top: "-40.0000%",
    });

    const shapes: SlideShape[] = [
      {
        id: "vid-ok",
        kind: "video",
        x: 5,
        y: 10,
        width: 40,
        height: 30,
        color: "#1f2329",
        mediaUrl: "https://cdn.example.com/demo.mp4",
        posterUrl: "https://cdn.example.com/poster.png",
        loop: true,
      },
      {
        id: "vid-empty",
        kind: "video",
        x: 5,
        y: 45,
        width: 40,
        height: 30,
        color: "#1f2329",
        mediaUrl: "",
      },
      {
        id: "aud-ok",
        kind: "audio",
        x: 50,
        y: 10,
        width: 45,
        height: 12,
        color: "#3370ff",
        mediaUrl: "/api/files/15",
      },
      {
        id: "aud-unsafe",
        kind: "audio",
        x: 50,
        y: 25,
        width: 45,
        height: 12,
        color: "#3370ff",
        mediaUrl: "javascript:alert(1)",
      },
      {
        id: "img-crop",
        kind: "image",
        x: 50,
        y: 45,
        width: 40,
        height: 40,
        color: "#ffffff",
        fileId: 8,
        crop: { x: 0.25, y: 0.2, w: 0.5, h: 0.5 },
      },
    ];

    const html = renderToStaticMarkup(
      <SlideShapes shapes={shapes} editable={false} selected={null} interactiveMedia />,
    );
    expect(html).toContain("<video");
    expect(html).toContain("https://cdn.example.com/demo.mp4");
    expect(html).toContain("https://cdn.example.com/poster.png");
    expect(html).toContain("data-slide-video-placeholder");
    expect(html).toContain("<audio");
    expect(html).toContain("/api/files/15");
    expect(html).not.toContain("javascript:alert(1)");
    expect(html).toContain("data-slide-image-cropped");
    expect(html).toContain("width:200.0000%");
    expect(html).toContain("left:-50.0000%");
  });

  it("clamps image crop sliders and renders crop panel + media controls without native select", () => {
    expect(SLIDE_CROP_PRESETS.map((p) => p.id)).toEqual(["free", "16:9", "4:3", "1:1"]);
    expect(updateImageCropField({ x: 0.5, y: 0, w: 0.5, h: 1 }, "x", 0.7)).toEqual({ x: 0.7, y: 0, w: 0.3, h: 1 });
    expect(updateImageCropField({ x: 0.6, y: 0.5, w: 0.3, h: 0.4 }, "w", 0.8)).toEqual({ x: 0.2, y: 0.5, w: 0.8, h: 0.4 });
    expect(updateImageCropField(undefined, "y", 0.3)).toEqual({ x: 0, y: 0.3, w: 1, h: 0.7 });

    const imageHtml = renderToStaticMarkup(
      <SlideShapeControls
        shape={{
          id: "img-1",
          kind: "image",
          x: 20,
          y: 20,
          width: 40,
          height: 40,
          color: "#ffffff",
          fileId: 3,
          crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
        }}
        defaultCropOpen
        onChange={() => {}}
        onDelete={() => {}}
        onOrder={() => {}}
        onAlign={() => {}}
      />,
    );
    expect(imageHtml).not.toContain("<select");
    expect(imageHtml).toContain("data-slides-crop-toggle");
    expect(imageHtml).toContain("data-slides-crop-panel");
    expect(imageHtml).toContain('data-slides-crop-preset="free"');
    expect(imageHtml).toContain('data-slides-crop-preset="16:9"');
    expect(imageHtml).toContain('data-slides-crop-preset="4:3"');
    expect(imageHtml).toContain('data-slides-crop-preset="1:1"');
    expect(imageHtml).toContain('data-slides-crop-slider="x"');
    expect(imageHtml).toContain('data-slides-crop-slider="y"');
    expect(imageHtml).toContain('data-slides-crop-slider="w"');
    expect(imageHtml).toContain('data-slides-crop-slider="h"');
    expect(imageHtml).toContain("data-slides-crop-reset");
    expect(imageHtml).toContain("裁剪图片");
    expect(imageHtml).toContain("重置裁剪");

    const videoHtml = renderToStaticMarkup(
      <SlideShapeControls
        shape={{
          id: "vid-1",
          kind: "video",
          x: 10,
          y: 10,
          width: 50,
          height: 40,
          color: "#1f2329",
          mediaUrl: "",
          autoplay: true,
          loop: true,
        }}
        onChange={() => {}}
        onDelete={() => {}}
        onOrder={() => {}}
        onAlign={() => {}}
      />,
    );
    expect(videoHtml).not.toContain("<select");
    expect(videoHtml).toContain("data-slides-media-toggle");
    expect(videoHtml).toContain("data-slides-media-panel");
    expect(videoHtml).toContain("data-slides-media-url-input");
    expect(videoHtml).toContain("data-slides-poster-url-input");
    expect(videoHtml).toContain("data-slides-media-autoplay");
    expect(videoHtml).toContain("data-slides-media-loop");
    expect(videoHtml).toContain("自动播放");
    expect(videoHtml).toContain("循环播放");

    const audioHtml = renderToStaticMarkup(
      <SlideShapeControls
        shape={{
          id: "aud-1",
          kind: "audio",
          x: 10,
          y: 60,
          width: 50,
          height: 14,
          color: "#3370ff",
          mediaUrl: "",
        }}
        onChange={() => {}}
        onDelete={() => {}}
        onOrder={() => {}}
        onAlign={() => {}}
      />,
    );
    expect(audioHtml).toContain("data-slides-media-panel");
    expect(audioHtml).toContain("音频链接");
    expect(audioHtml).not.toContain("data-slides-poster-url-input");
  });
});
