import { describe, expect, it, vi } from "vitest";
import { ApiError, type SlidesPage } from "@/lib/api";
import { SlidesDraftQueue, type SlideContent } from "./slidesDraft";

const page: SlidesPage = { id: 1, slidesId: 2, pos: 1, title: "", body: "", background: "", notes: "", shapes: [], revision: 1, updatedAt: "2026-01-01T00:00:00Z" };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("slide drafts", () => {
  it("serialises rapid input and keeps the latest characters", async () => {
    let finish!: (value: SlidesPage) => void;
    const write = vi.fn().mockImplementationOnce((_base: SlidesPage, content: SlideContent) => new Promise<SlidesPage>((resolve) => { finish = () => resolve({ ...page, ...content, revision: 2 }); }))
      .mockImplementationOnce((base: SlidesPage, content: SlideContent) => Promise.resolve({ ...base, ...content, revision: 3 }));
    const q = new SlidesDraftQueue(write, () => {}, () => {});
    q.edit(page, { title: "A" });
    q.edit(page, { title: "AB" });
    q.edit(page, { title: "ABCDE" });
    expect(q.get(page).content.title).toBe("ABCDE");
    finish(page); await tick(); await tick();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][0].revision).toBe(2);
    expect(write.mock.calls[1][1].title).toBe("ABCDE");
    expect(q.get(page).state).toBe("saved");
  });

  it("preserves input when the server reports a concurrent change", async () => {
    const q = new SlidesDraftQueue(() => Promise.reject(new ApiError(409, "conflict", "changed")), () => {}, () => {});
    q.edit(page, { title: "my draft" }); await tick();
    expect(q.get({ ...page, title: "other", revision: 2 }).content.title).toBe("my draft");
    expect(q.get(page).state).toBe("conflict");
  });

  it("keeps an unknown write result without automatically resending", async () => {
    const write = vi.fn().mockRejectedValue(new Error("network"));
    const q = new SlidesDraftQueue(write, () => {}, () => {});
    q.edit(page, { title: "draft" }); await tick();
    q.edit(page, { title: "draft again" }); await tick();
    expect(write).toHaveBeenCalledTimes(1);
    expect(q.get(page)).toMatchObject({ state: "unknown", content: { title: "draft again" } });
  });

  it("shows a newer server revision after the local draft is saved", async () => {
    const q = new SlidesDraftQueue((base, content) => Promise.resolve({ ...base, ...content, revision: base.revision + 1 }), () => {}, () => {});
    q.edit(page, { title: "local" }); await tick();
    expect(q.get({ ...page, title: "remote", revision: 3 }).content.title).toBe("remote");
  });

  it("accepts reordered JSON object keys from PostgreSQL while saving shapes", async () => {
    const shape = { id: "one", kind: "ellipse" as const, x: 20, y: 30, color: "#3370ff" };
    const q = new SlidesDraftQueue((base, content) => Promise.resolve({ ...base, ...content, shapes: [{ color: shape.color, y: shape.y, x: shape.x, kind: shape.kind, id: shape.id }], revision: base.revision + 1 }), () => {}, () => {});
    q.edit(page, { shapes: [shape] }); await tick();
    expect(q.get(page).state).toBe("saved");
  });
});
