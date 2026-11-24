import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  appendInkPoint,
  clearSlideInk,
  formatPresentationTime,
  isDarkSlideBackground,
  PRESENTER_INK_COLORS,
  PRESENTER_LASER_TRAIL_MAX,
  PresenterView,
  pushLaserTrailPoint,
  SlideSurface,
  startInkStroke,
  stepPresentationBackward,
  stepPresentationForward,
} from "./slides-presenter";
import type { SlidesPage } from "@/lib/api";

const page: SlidesPage = { id: 1, slidesId: 2, pos: 1, title: "公开标题", body: "公开正文", notes: "仅演示者可见的备注", background: "", shapes: [], hidden: false, revision: 1, updatedAt: "" };
const page2: SlidesPage = { ...page, id: 2, pos: 2, title: "第二页" };

describe("presentation surfaces", () => {
  it("keeps notes out of the audience slide while showing them to the presenter", () => {
    const audience = renderToStaticMarkup(<SlideSurface content={page}/>);
    const presenter = renderToStaticMarkup(<PresenterView pages={[page]} currentId={page.id} content={page} contentFor={() => page} onSelect={() => {}} onExit={() => {}}/>);
    expect(audience).toContain("公开标题");
    expect(audience).toContain("公开正文");
    expect(audience).not.toContain(page.notes);
    expect(presenter).toContain(page.notes);
    expect(presenter).toContain("1 / 1");
  });
  it("renders the centered title layout while retaining body content", () => {
    const html = renderToStaticMarkup(<SlideSurface content={{ ...page, layout: "title" }}/>);
    expect(html).toContain("text-center");
    expect(html).toContain("5.625cqw");
    expect(html).toContain("公开正文");
  });
  it("retains the title and body on the blank layout with the original large text geometry", () => {
    const html = renderToStaticMarkup(<SlideSurface content={{ ...page, layout: "blank-title" }}/>);
    expect(html).toContain("text-left");
    expect(html).toContain("5.625cqw");
    expect(html).toContain("公开标题");
    expect(html).toContain("公开正文");
  });
  it("formats elapsed time across minute and hour boundaries", () => {
    expect(formatPresentationTime(0)).toBe("00:00:00");
    expect(formatPresentationTime(3661)).toBe("01:01:01");
    expect(formatPresentationTime(-1)).toBe("00:00:00");
  });
  it("switches title and body to light ink on dark slide backgrounds", () => {
    expect(isDarkSlideBackground("#1f2329")).toBe(true);
    expect(isDarkSlideBackground("#f5f7fb")).toBe(false);
    expect(isDarkSlideBackground("")).toBe(false);
    const html = renderToStaticMarkup(<SlideSurface content={{ ...page, background: "#1f2329" }}/>);
    expect(html).toContain("text-white");
  });

  it("maintains an 8-point laser comet trail and renders laser mode in PresenterView", () => {
    let trail: { x: number; y: number }[] = [];
    for (let i = 0; i < 12; i++) {
      trail = pushLaserTrailPoint(trail, { x: i * 10, y: i * 8 });
    }
    expect(trail).toHaveLength(PRESENTER_LASER_TRAIL_MAX);
    expect(trail[0]).toEqual({ x: 40, y: 32 });
    expect(trail[7]).toEqual({ x: 100, y: 88 });

    const html = renderToStaticMarkup(
      <PresenterView
        pages={[page]}
        currentId={page.id}
        content={page}
        contentFor={() => page}
        tool="laser"
        laserTrail={trail}
        onSelect={() => {}}
        onExit={() => {}}
      />,
    );
    expect(html).toContain("data-presenter-tools");
    expect(html).toContain('data-presenter-tool="laser"');
    expect(html).toContain("data-presenter-laser-trail");
    expect(html).toContain("data-presenter-laser-dot");
    expect(html).toContain("#ff3b30");
  });

  it("supports per-slide freehand ink drawing, color switching, and clearing", () => {
    expect(PRESENTER_INK_COLORS).toEqual(["#ff3b30", "#3370ff", "#00b42a", "#ff9500", "#ffffff"]);
    let ink = startInkStroke({}, page.id, { x: 10, y: 20 }, "#3370ff", "stroke-1");
    ink = appendInkPoint(ink, page.id, { x: 25, y: 35 });
    ink = appendInkPoint(ink, page.id, { x: 42, y: 50 });
    ink = startInkStroke(ink, page2.id, { x: 50, y: 50 }, "#00b42a", "stroke-2");

    expect(ink[page.id]).toHaveLength(1);
    expect(ink[page.id][0].points).toHaveLength(3);
    expect(ink[page2.id]).toHaveLength(1);

    const html = renderToStaticMarkup(
      <PresenterView
        pages={[page, page2]}
        currentId={page.id}
        content={page}
        contentFor={() => page}
        tool="ink"
        inkColor="#3370ff"
        inkByPage={ink}
        onSelect={() => {}}
        onExit={() => {}}
      />,
    );
    expect(html).toContain('data-presenter-tool="ink"');
    expect(html).toContain('data-presenter-ink-color="#3370ff"');
    expect(html).toContain("data-presenter-ink-layer");
    expect(html).toContain('data-presenter-ink-stroke="stroke-1"');
    expect(html).toContain("data-presenter-clear-ink");

    const cleared = clearSlideInk(ink, page.id);
    expect(cleared[page.id]).toBeUndefined();
    expect(cleared[page2.id]).toHaveLength(1);
  });

  it("steps through click-triggered element animations before advancing slides", () => {
    const animatedPage: SlidesPage = {
      ...page,
      shapes: [
        { id: "s1", kind: "rectangle", x: 10, y: 20, width: 20, height: 20, color: "#3370ff" },
        { id: "s2", kind: "ellipse", x: 40, y: 20, width: 20, height: 20, color: "#00b42a" },
        { id: "s3", kind: "triangle", x: 70, y: 20, width: 20, height: 20, color: "#ff7d00" },
      ],
    };
    const animations = {
      [page.id]: {
        s1: { effect: "fade-in" as const, order: 1, trigger: "click" as const },
        s2: { effect: "slide-up" as const, order: 2, trigger: "with_prev" as const },
        s3: { effect: "zoom-in" as const, order: 3, trigger: "click" as const },
      },
    };
    const pages = [animatedPage, page2];

    // Step 0 -> Step 1 (s1 + s2 together)
    expect(stepPresentationForward(pages, page.id, 0, animations)).toEqual({ pageId: page.id, animStep: 1 });
    // Step 1 -> Step 2 (s3)
    expect(stepPresentationForward(pages, page.id, 1, animations)).toEqual({ pageId: page.id, animStep: 2 });
    // Step 2 -> next slide at step 0
    expect(stepPresentationForward(pages, page.id, 2, animations)).toEqual({ pageId: page2.id, animStep: 0 });
    // End of deck
    expect(stepPresentationForward(pages, page2.id, 0, animations)).toBeNull();

    // Backward from page 2 lands on page 1 fully revealed (step 2), then steps back to 1 and 0
    expect(stepPresentationBackward(pages, page2.id, 0, animations)).toEqual({ pageId: page.id, animStep: 2 });
    expect(stepPresentationBackward(pages, page.id, 2, animations)).toEqual({ pageId: page.id, animStep: 1 });
    expect(stepPresentationBackward(pages, page.id, 1, animations)).toEqual({ pageId: page.id, animStep: 0 });
    expect(stepPresentationBackward(pages, page.id, 0, animations)).toBeNull();

    // Verify rendered PresenterView shows step badge and step-0 hidden entrance shape
    const htmlStep0 = renderToStaticMarkup(
      <PresenterView
        pages={pages}
        currentId={page.id}
        content={animatedPage}
        contentFor={() => animatedPage}
        animations={animations}
        animStep={0}
        onSelect={() => {}}
        onExit={() => {}}
      />,
    );
    expect(htmlStep0).toContain("data-presenter-anim-step");
    expect(htmlStep0).toContain("动画 0/2");
    expect(htmlStep0).toContain('data-slide-anim-visible="false"');

    const htmlStep1 = renderToStaticMarkup(
      <PresenterView
        pages={pages}
        currentId={page.id}
        content={animatedPage}
        contentFor={() => animatedPage}
        animations={animations}
        animStep={1}
        onSelect={() => {}}
        onExit={() => {}}
      />,
    );
    expect(htmlStep1).toContain("动画 1/2");
    expect(htmlStep1).toContain("jiange-shape-fade-in");
    expect(htmlStep1).toContain("jiange-shape-slide-up");
  });
});
