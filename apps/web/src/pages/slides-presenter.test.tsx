import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { formatPresentationTime, isDarkSlideBackground, PresenterView, SlideSurface } from "./slides-presenter";
import type { SlidesPage } from "@/lib/api";

const page: SlidesPage = { id: 1, slidesId: 2, pos: 1, title: "公开标题", body: "公开正文", notes: "仅演示者可见的备注", background: "", shapes: [], hidden: false, revision: 1, updatedAt: "" };

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
});
