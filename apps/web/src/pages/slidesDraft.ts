import { ApiError, type SlidesPage } from "@/lib/api";

export type SlideContent = Pick<SlidesPage, "title" | "body" | "background" | "notes" | "shapes">;
const sameShapes = (a: SlideContent["shapes"], b: SlideContent["shapes"]) => a.length === b.length && a.every((item, i) => { const other = b[i]; return item.id === other.id && item.kind === other.kind && item.x === other.x && item.y === other.y && item.color === other.color && (item.width ?? 16) === (other.width ?? 16) && (item.height ?? 20) === (other.height ?? 20) && (item.rotation ?? 0) === (other.rotation ?? 0) && (item.text ?? "") === (other.text ?? "") && (item.fontSize ?? 24) === (other.fontSize ?? 24) && (item.bold ?? false) === (other.bold ?? false) && (item.align ?? "left") === (other.align ?? "left") && item.fileId === other.fileId; });
export const sameSlideContent = (a: SlideContent, b: SlideContent) => a.title === b.title && a.body === b.body && a.background === b.background && a.notes === b.notes && sameShapes(a.shapes, b.shapes);
export type SlideDraft = { page: SlidesPage; content: SlideContent; state: "saved" | "saving" | "conflict" | "unknown" };
type History = { undo: SlideContent[]; redo: SlideContent[]; group: string | null; at: number };
const HISTORY_LIMIT = 100;

/** Serialise writes per page; keep the user's latest text when a write fails. */
export class SlidesDraftQueue {
  private drafts = new Map<number, SlideDraft>();
  private history = new Map<number, History>();
  private onChange: () => void;

  constructor(
    private readonly write: (page: SlidesPage, content: SlideContent) => Promise<SlidesPage>,
    private readonly onSaved: (page: SlidesPage) => void,
    onChange: () => void,
  ) { this.onChange = onChange; }

  dispose() { this.onChange = () => {}; }

  hasUnsaved() { return [...this.drafts.values()].some((draft) => draft.state !== "saved"); }

  get(page: SlidesPage): SlideDraft {
    const current = this.drafts.get(page.id);
    if (current && (current.state !== "saved" || current.page.revision >= page.revision)) {
      // Ordering can change without a content revision. Do not put an older
      // position back into the query cache after a background-only update.
      if (current.state === "saved" && current.page.revision === page.revision && current.page.pos !== page.pos) current.page = { ...current.page, pos: page.pos, updatedAt: page.updatedAt };
      return current;
    }
    if (current) { this.drafts.delete(page.id); this.history.delete(page.id); }
    return { page, content: { title: page.title, body: page.body, background: page.background, notes: page.notes, shapes: page.shapes }, state: "saved" };
  }

  edit(page: SlidesPage, patch: Partial<SlideContent>, group?: string) {
    const current = this.get(page);
    const next: SlideDraft = { ...current, content: { ...current.content, ...patch } };
    if (sameSlideContent(current.content, next.content)) return;
    const history = this.history.get(page.id) ?? { undo: [], redo: [], group: null, at: 0 };
    const now = Date.now();
    if (!group || history.group !== group || now - history.at > 1000 || history.redo.length) {
      history.undo.push(current.content);
      if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
    }
    history.redo = [];
    history.group = group ?? null;
    history.at = now;
    this.history.set(page.id, history);
    this.apply(page.id, next);
  }

  endGroup(id: number) { const history = this.history.get(id); if (history) history.group = null; }

  /** Accept a visibility-only revision without discarding page edit history. */
  acceptVisibility(base: SlidesPage, saved: SlidesPage): boolean {
    const current = this.drafts.get(base.id);
    if (!current) return true;
    if (current.state !== "saved" || current.page.revision !== base.revision || current.page.hidden !== base.hidden || !sameSlideContent(current.content, saved)) return false;
    current.page = saved;
    this.onChange();
    return true;
  }

  /** Adopt a confirmed background batch without losing newer local edits. */
  acceptBackgroundBatch(before: readonly SlidesPage[], after: readonly SlidesPage[]): boolean {
    if (before.length !== after.length || !before.length) return false;
    const pairs = before.map((page, index) => {
      const existing = this.drafts.get(page.id);
      const superseded = !!existing && existing.state === "saved" && existing.page.revision < page.revision;
      const current = !existing || superseded ? { page, content: { title: page.title, body: page.body, background: page.background, notes: page.notes, shapes: page.shapes }, state: "saved" as const } : existing;
      return { page, saved: after[index], current, superseded };
    });
    for (const { page, saved, current } of pairs) {
      if (!saved || saved.id !== page.id || saved.slidesId !== page.slidesId || saved.pos !== page.pos || saved.hidden !== page.hidden || saved.revision !== page.revision + (saved.background === page.background ? 0 : 1) || current.state !== "saved" || current.page.revision !== page.revision || current.page.hidden !== page.hidden || !sameSlideContent(current.content, page) || !sameSlideContent({ ...page, background: saved.background }, saved)) return false;
    }
    for (const { page, saved, current, superseded } of pairs) {
      if (page.background === saved.background) continue;
      if (superseded) this.history.delete(page.id);
      const history = this.history.get(page.id) ?? { undo: [], redo: [], group: null, at: 0 };
      history.undo.push(current.content); if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
      history.redo = []; history.group = null; this.history.set(page.id, history);
      this.drafts.set(page.id, { page: saved, content: { title: saved.title, body: saved.body, background: saved.background, notes: saved.notes, shapes: saved.shapes }, state: "saved" });
    }
    this.onChange(); return true;
  }

  canUndo(page: SlidesPage) { this.get(page); return !!this.history.get(page.id)?.undo.length; }
  canRedo(page: SlidesPage) { this.get(page); return !!this.history.get(page.id)?.redo.length; }

  undo(page: SlidesPage) { this.travel(page, "undo"); }
  redo(page: SlidesPage) { this.travel(page, "redo"); }

  private travel(page: SlidesPage, direction: "undo" | "redo") {
    const current = this.get(page);
    const history = this.history.get(page.id);
    if (!history) return;
    const from = history[direction], to = history[direction === "undo" ? "redo" : "undo"];
    const content = from.pop();
    if (!content) return;
    to.push(current.content);
    if (to.length > HISTORY_LIMIT) to.shift();
    history.group = null;
    this.apply(page.id, { ...current, content });
  }

  private apply(id: number, next: SlideDraft) {
    this.drafts.set(id, next);
    this.onChange();
    if (next.state === "saved") void this.save(id);
  }

  private async save(id: number) {
    const current = this.drafts.get(id);
    if (!current || current.state !== "saved") return;
    const sent = { ...current.content };
    const base = current.page;
    current.state = "saving";
    this.onChange();
    try {
      const saved = await this.write(base, sent);
      if (saved.id !== id || saved.revision !== base.revision + 1 || saved.hidden !== base.hidden || saved.title !== sent.title || saved.body !== sent.body || saved.background !== sent.background || saved.notes !== sent.notes || !sameShapes(saved.shapes, sent.shapes)) {
        throw new Error("unexpected slide response");
      }
      const latest = this.drafts.get(id);
      if (!latest) return;
      latest.page = saved;
      latest.state = "saved";
      this.onSaved(saved);
      this.onChange();
      if (!sameSlideContent(latest.content, sent)) void this.save(id);
    } catch (error) {
      const latest = this.drafts.get(id);
      if (!latest) return;
      // A lost response may mean the write committed; never blindly replay it.
      latest.state = error instanceof ApiError && error.status === 409 ? "conflict" : "unknown";
      this.onChange();
    }
  }
}
