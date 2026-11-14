import { describe, expect, it, vi } from "vitest";
import { ApiError, type SlidesPage } from "@/lib/api";
import { SlidesDraftQueue, type SlideContent } from "./slidesDraft";
import { patchSlideShape } from "./slides-shape-state";

const page: SlidesPage = { id: 1, slidesId: 2, pos: 1, title: "", body: "", background: "", notes: "", shapes: [], hidden: false, revision: 1, updatedAt: "2026-01-01T00:00:00Z" };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("slide drafts", () => {
  it("saves and undoes layout without losing existing title, body or notes", async () => {
    const source = { ...page, title: "标题", body: "保留正文", notes: "备注" };
    const q = new SlidesDraftQueue((base, content) => Promise.resolve({ ...base, ...content, revision: base.revision + 1 }), () => {}, () => {});
    q.edit(source, { layout: "title" }); await tick();
    expect(q.get(source).content).toMatchObject({ layout: "title", title: "标题", body: "保留正文", notes: "备注" });
    q.edit(source, { layout: "blank-title" }); await tick();
    expect(q.get(source).content).toMatchObject({ layout: "blank-title", title: "标题", body: "保留正文", notes: "备注" });
    q.undo(source); await tick();
    expect(q.get(source).content).toMatchObject({ layout: "title", title: "标题", body: "保留正文", notes: "备注" });
    q.redo(source); await tick();
    expect(q.get(source).content.layout).toBe("blank-title");
  });
  it("adopts a confirmed background batch and permits undo for each changed page", async () => {
    const second = { ...page, id: 2, pos: 2, title: "第二页" };
    const q = new SlidesDraftQueue((base, content) => Promise.resolve({ ...base, ...content, revision: base.revision + 1 }), () => {}, () => {});
    const after = [page, second].map((item) => ({ ...item, background: "#112233", revision: 2 }));
    expect(q.acceptBackgroundBatch([page, second], after)).toBe(true);
    expect(q.get(after[0]).content.background).toBe("#112233");
    expect(q.get(after[1]).content.title).toBe("第二页");
    q.undo(after[1]); await tick();
    expect(q.get(after[1]).content.background).toBe("");
    expect(q.get(after[0]).content.background).toBe("#112233");
  });
  it("undoes and redoes a background batch as one guarded history transition", () => {
    const second = { ...page, id: 2, pos: 2, background: "#abcdef" };
    const q = new SlidesDraftQueue(() => new Promise(() => {}), () => {}, () => {});
    const before = [page, second];
    const applied = before.map((item) => ({ ...item, background: "#112233", revision: 2 }));
    expect(q.acceptBackgroundBatch(before, applied)).toBe(true);
    expect(q.canTravelBackgroundBatch(applied, applied, before, "undo")).toBe(true);
    const restored = before.map((item) => ({ ...item, revision: 3 }));
    expect(q.acceptBackgroundTravel(applied, restored, applied, before, "undo")).toBe(true);
    expect(restored.map((item) => q.get(item).content.background)).toEqual(["", "#abcdef"]);
    expect(q.canTravelBackgroundBatch(restored, before, applied, "redo")).toBe(true);
    const redone = applied.map((item) => ({ ...item, revision: 4 }));
    expect(q.acceptBackgroundTravel(restored, redone, before, applied, "redo")).toBe(true);
    expect(redone.map((item) => q.get(item).content.background)).toEqual(["#112233", "#112233"]);
  });
  it("supports consecutive background batches in reverse and forward order", () => {
    const second = { ...page, id: 2, pos: 2 }, original = [page, second];
    const q = new SlidesDraftQueue(() => new Promise(() => {}), () => {}, () => {});
    const first = original.map((item) => ({ ...item, background: "#112233", revision: 2 }));
    const secondBatch = first.map((item) => ({ ...item, background: "#445566", revision: 3 }));
    expect(q.acceptBackgroundBatch(original, first)).toBe(true);
    expect(q.acceptBackgroundBatch(first, secondBatch)).toBe(true);
    const undoSecond = first.map((item) => ({ ...item, revision: 4 }));
    expect(q.acceptBackgroundTravel(secondBatch, undoSecond, secondBatch, first, "undo")).toBe(true);
    const undoFirst = original.map((item) => ({ ...item, revision: 5 }));
    expect(q.acceptBackgroundTravel(undoSecond, undoFirst, first, original, "undo")).toBe(true);
    const redoFirst = first.map((item) => ({ ...item, revision: 6 }));
    expect(q.acceptBackgroundTravel(undoFirst, redoFirst, original, first, "redo")).toBe(true);
    const redoSecond = secondBatch.map((item) => ({ ...item, revision: 7 }));
    expect(q.acceptBackgroundTravel(redoFirst, redoSecond, first, secondBatch, "redo")).toBe(true);
  });
  it("reports new content edits but not confirmed background history moves", () => {
    const onEdit = vi.fn();
    const q = new SlidesDraftQueue(() => new Promise(() => {}), () => {}, () => {}, onEdit);
    q.edit(page, { title: "" });
    expect(onEdit).not.toHaveBeenCalled();
    const applied = { ...page, background: "#112233", revision: 2 };
    expect(q.acceptBackgroundBatch([page], [applied])).toBe(true);
    expect(q.acceptBackgroundTravel([applied], [{ ...page, revision: 3 }], [applied], [page], "undo")).toBe(true);
    expect(onEdit).not.toHaveBeenCalled();
    q.edit({ ...page, revision: 3 }, { title: "新标题" });
    expect(onEdit).toHaveBeenCalledTimes(1);
  });
  it("does not mistake an identical single-page redo for a batch history entry", async () => {
    const q = new SlidesDraftQueue((base, content) => Promise.resolve({ ...base, ...content, revision: base.revision + 1 }), () => {}, () => {});
    q.edit(page, { background: "#112233" }); await tick();
    const colored = q.get(page).page;
    q.undo(colored); await tick();
    const restored = q.get(colored).page;
    expect(q.canRedo(restored)).toBe(true);
    expect(q.isBackgroundHistoryTop(restored, colored, "redo", 42)).toBe(false);
    q.redo(restored); await tick();
    expect(q.get(restored).content.background).toBe("#112233");
  });
  it("refuses batch history after another page gained an unsaved edit", () => {
    const second = { ...page, id: 2, pos: 2 };
    const q = new SlidesDraftQueue(() => new Promise(() => {}), () => {}, () => {});
    const before = [page, second], applied = before.map((item) => ({ ...item, background: "#112233", revision: 2 }));
    expect(q.acceptBackgroundBatch(before, applied)).toBe(true);
    q.edit(applied[1], { title: "未保存的修改" });
    expect(q.canTravelBackgroundBatch(applied, applied, before, "undo")).toBe(false);
    const restored = before.map((item) => ({ ...item, revision: 3 }));
    expect(q.acceptBackgroundTravel(applied, restored, applied, before, "undo")).toBe(false);
    expect(q.get(applied[1]).content.title).toBe("未保存的修改");
    expect(q.get(applied[0]).content.background).toBe("#112233");
  });
  it("leaves already-matching pages alone while travelling a batch", () => {
    const second = { ...page, id: 2, pos: 2, background: "#112233" };
    const q = new SlidesDraftQueue(() => new Promise(() => {}), () => {}, () => {});
    const before = [page, second], applied = [{ ...page, background: "#112233", revision: 2 }, second];
    expect(q.acceptBackgroundBatch(before, applied)).toBe(true);
    expect(q.canTravelBackgroundBatch(applied, applied, before, "undo")).toBe(true);
    const restored = [{ ...page, revision: 3 }, second];
    expect(q.acceptBackgroundTravel(applied, restored, applied, before, "undo")).toBe(true);
    expect(q.get(second).content.background).toBe("#112233");
    expect(q.canTravelBackgroundBatch([restored[0]], before, applied, "redo")).toBe(false);
  });
  it("rejects the whole background batch if any page gained a local edit", () => {
    const second = { ...page, id: 2, pos: 2 };
    const q = new SlidesDraftQueue(() => new Promise(() => {}), () => {}, () => {});
    q.edit(second, { title: "较新的输入" });
    const after = [page, second].map((item) => ({ ...item, background: "#112233", revision: 2 }));
    expect(q.acceptBackgroundBatch([page, second], after)).toBe(false);
    expect(q.get(page).content.background).toBe("");
    expect(q.get(second).content.title).toBe("较新的输入");
  });
  it("preserves a newer order when the content revision is unchanged", async () => {
    const q = new SlidesDraftQueue((base, content) => Promise.resolve({ ...base, ...content, revision: base.revision + 1 }), () => {}, () => {});
    q.edit(page, { title: "标题" }); await tick();
    const saved = q.get(page).page;
    expect(q.get({ ...saved, pos: 8 }).page.pos).toBe(8);
  });
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

  it("preserves edit undo history across a confirmed visibility-only revision", async () => {
    const q = new SlidesDraftQueue((base, content) => Promise.resolve({ ...base, ...content, revision: base.revision + 1 }), () => {}, () => {});
    q.edit(page, { title: "已编辑" }); await tick();
    const base = q.get(page).page;
    const changed = { ...base, hidden: true, revision: base.revision + 1 };
    expect(q.acceptVisibility(base, changed)).toBe(true);
    expect(q.get(changed).page.hidden).toBe(true);
    expect(q.canUndo(changed)).toBe(true);
    q.undo(changed); await tick();
    expect(q.get(changed).content.title).toBe("");
    expect(q.get(changed).page.hidden).toBe(true);
  });

  it("refuses to replace a dirty or mismatched draft with a visibility response", async () => {
    let finish!: () => void;
    const q = new SlidesDraftQueue((base, content) => new Promise((resolve) => { finish = () => resolve({ ...base, ...content, revision: base.revision + 1 }); }), () => {}, () => {});
    q.edit(page, { title: "未保存" });
    expect(q.acceptVisibility(page, { ...page, hidden: true, revision: 2 })).toBe(false);
    expect(q.get(page).content.title).toBe("未保存");
    finish(); await tick();
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
