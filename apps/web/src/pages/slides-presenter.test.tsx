import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { formatPresentationTime, PresenterView, SlideSurface } from "./slides-presenter";
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
  it("formats elapsed time across minute and hour boundaries", () => {
    expect(formatPresentationTime(0)).toBe("00:00:00");
    expect(formatPresentationTime(3661)).toBe("01:01:01");
    expect(formatPresentationTime(-1)).toBe("00:00:00");
  });
});
