import { describe, expect, it, vi } from "vitest";
import { ApiError, type SlidesPage } from "@/lib/api";
import { SlidesDraftQueue, type SlideContent } from "./slidesDraft";
import { patchSlideShape } from "./slides-shape-state";

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

  it("serialises size and rotation edits while another save is in flight", async () => {
    let finish!: () => void;
    const shape = { id: "one", kind: "ellipse" as const, x: 20, y: 30, color: "#3370ff" };
    const write = vi.fn().mockImplementationOnce((base: SlidesPage, content: SlideContent) => new Promise<SlidesPage>((resolve) => { finish = () => resolve({ ...base, ...content, revision: 2 }); }))
      .mockImplementationOnce((base: SlidesPage, content: SlideContent) => Promise.resolve({ ...base, ...content, revision: 3 }));
    const q = new SlidesDraftQueue(write, () => {}, () => {});
    q.edit(page, { shapes: [shape] });
    q.edit(page, { shapes: [{ ...shape, width: 35, height: 25, rotation: 45 }] });
    finish(); await tick(); await tick();
    expect(write.mock.calls[1][1].shapes[0]).toMatchObject({ width: 35, height: 25, rotation: 45 });
    expect(q.get(page).state).toBe("saved");
  });

  it("merges separate shape edits and keeps resized shapes within the canvas", () => {
    const shape = { id: "one", kind: "rectangle" as const, x: 75, y: 70, color: "#3370ff" };
    const width = patchSlideShape([shape], "one", { width: 40 });
    const height = patchSlideShape(width, "one", { height: 35 });
    const rotated = patchSlideShape(height, "one", { rotation: 45 });
    expect(rotated[0]).toMatchObject({ x: 60, y: 65, width: 40, height: 35, rotation: 45 });
  });

  it("coalesces typing, undoes and redoes edits, and clears redo on new edits", async () => {
    const q = new SlidesDraftQueue((base, content) => Promise.resolve({ ...base, ...content, revision: base.revision + 1 }), () => {}, () => {});
    q.edit(page, { title: "A" }, "title");
    q.edit(page, { title: "AB" }, "title");
    q.endGroup(page.id);
    q.edit(page, { body: "Body" }, "body");
    q.undo(page);
    expect(q.get(page).content).toMatchObject({ title: "AB", body: "" });
    q.undo(page);
    expect(q.get(page).content.title).toBe("");
    q.redo(page);
    expect(q.get(page).content.title).toBe("AB");
    q.edit(page, { notes: "new" });
    expect(q.canRedo(page)).toBe(false);
    await tick(); await tick();
    expect(q.get(page).state).toBe("saved");
  });

  it("serialises an undo made while the original write is in flight", async () => {
    let finish!: () => void;
    const write = vi.fn().mockImplementationOnce((base: SlidesPage, content: SlideContent) => new Promise<SlidesPage>((resolve) => { finish = () => resolve({ ...base, ...content, revision: 2 }); }))
      .mockImplementationOnce((base: SlidesPage, content: SlideContent) => Promise.resolve({ ...base, ...content, revision: 3 }));
    const q = new SlidesDraftQueue(write, () => {}, () => {});
    q.edit(page, { title: "changed" });
    q.undo(page);
    expect(q.get(page).content.title).toBe("");
    finish(); await tick(); await tick();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][0].revision).toBe(2);
    expect(write.mock.calls[1][1].title).toBe("");
    expect(q.get(page).state).toBe("saved");
  });

  it("does not replay an undo when a save result is unknown", async () => {
    const write = vi.fn().mockRejectedValue(new Error("network"));
    const q = new SlidesDraftQueue(write, () => {}, () => {});
    q.edit(page, { title: "changed" }); await tick();
    q.undo(page); await tick();
    expect(q.get(page)).toMatchObject({ state: "unknown", content: { title: "" } });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("clears local history after observing a newer remote revision", async () => {
    const q = new SlidesDraftQueue((base, content) => Promise.resolve({ ...base, ...content, revision: base.revision + 1 }), () => {}, () => {});
    q.edit(page, { title: "local" }); await tick();
    const remote = { ...page, title: "remote", revision: 3 };
    expect(q.canUndo(remote)).toBe(false);
    q.undo(remote);
    expect(q.get(remote).content.title).toBe("remote");
  });

  it("does not record unchanged shape selections", () => {
    const shape = { id: "one", kind: "ellipse" as const, x: 20, y: 30, color: "#3370ff" };
    const current = { ...page, shapes: [shape] };
    const write = vi.fn();
    const q = new SlidesDraftQueue(write, () => {}, () => {});
    q.edit(current, { shapes: [{ ...shape }] });
    expect(q.canUndo(current)).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("saves and undoes text box content and formatting", async () => {
    const text = { id: "text", kind: "text" as const, x: 10, y: 20, color: "#1f2329", text: "", fontSize: 24 };
    const initial = { ...page, shapes: [text] };
    const write = vi.fn((base: SlidesPage, content: SlideContent) => Promise.resolve({ ...base, ...content, revision: base.revision + 1 }));
    const q = new SlidesDraftQueue(write, () => {}, () => {});
    q.edit(initial, { shapes: [{ ...text, text: "协作" }] }, "text:text");
    q.edit(initial, { shapes: [{ ...text, text: "协作计划" }] }, "text:text");
    q.endGroup(initial.id);
    q.edit(initial, { shapes: [{ ...text, text: "协作计划", bold: true, fontSize: 32, align: "center" }] });
    q.undo(initial);
    expect(q.get(initial).content.shapes[0]).toMatchObject({ text: "协作计划", fontSize: 24 });
    q.redo(initial);
    await tick(); await tick();
    expect(write.mock.calls.at(-1)?.[1].shapes[0]).toMatchObject({ text: "协作计划", bold: true, fontSize: 32, align: "center" });
    expect(q.get(initial).state).toBe("saved");
  });

  it("persists the image reference through geometry edits and undo", async () => {
    const image = { id: "image", kind: "image" as const, x: 20, y: 30, width: 35, height: 35, color: "#ffffff", fileId: 42 };
    const write = vi.fn((base: SlidesPage, content: SlideContent) => Promise.resolve({ ...base, ...content, revision: base.revision + 1 }));
    const q = new SlidesDraftQueue(write, () => {}, () => {});
    q.edit(page, { shapes: [image] });
    q.edit(page, { shapes: patchSlideShape(q.get(page).content.shapes, image.id, { x: 45, width: 40 }) });
    await tick(); await tick();
    expect(write.mock.calls.at(-1)?.[1].shapes[0]).toMatchObject({ fileId: 42, x: 45, width: 40 });
    q.undo(page);
    expect(q.get(page).content.shapes[0]).toMatchObject({ fileId: 42, x: 20, width: 35 });
  });

  it("does not report an image as saved if the response changes its file reference", async () => {
    const image = { id: "image", kind: "image" as const, x: 20, y: 30, color: "#ffffff", fileId: 42 };
    const q = new SlidesDraftQueue((base, content) => Promise.resolve({ ...base, ...content, shapes: [{ ...image, fileId: 43 }], revision: base.revision + 1 }), () => {}, () => {});
    q.edit(page, { shapes: [image] }); await tick();
    expect(q.get(page)).toMatchObject({ state: "unknown", content: { shapes: [{ fileId: 42 }] } });
  });
});
