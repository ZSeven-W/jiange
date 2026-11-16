import { ApiError, type SlidesPage } from "@/lib/api";

export type SlideContent = Pick<SlidesPage, "title" | "body" | "background" | "layout" | "notes" | "shapes">;
const sameShapes = (a: SlideContent["shapes"], b: SlideContent["shapes"]) => a.length === b.length && a.every((item, i) => { const other = b[i]; return item.id === other.id && item.kind === other.kind && item.x === other.x && item.y === other.y && item.color === other.color && (item.width ?? 16) === (other.width ?? 16) && (item.height ?? 20) === (other.height ?? 20) && (item.rotation ?? 0) === (other.rotation ?? 0) && (item.text ?? "") === (other.text ?? "") && (item.fontSize ?? 24) === (other.fontSize ?? 24) && (item.bold ?? false) === (other.bold ?? false) && (item.align ?? "left") === (other.align ?? "left") && item.fileId === other.fileId; });
export const sameSlideContent = (a: SlideContent, b: SlideContent) => a.title === b.title && a.body === b.body && a.background === b.background && (a.layout ?? "") === (b.layout ?? "") && a.notes === b.notes && sameShapes(a.shapes, b.shapes);
export type SlideDraft = { page: SlidesPage; content: SlideContent; state: "saved" | "saving" | "pending" | "conflict" | "unknown" };
type HistoryEntry = { content: SlideContent; batchId?: number };
type History = { undo: HistoryEntry[]; redo: HistoryEntry[]; group: string | null; at: number };
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
    private readonly onUserEdit: () => void = () => {},
    private readonly mayWrite: () => boolean = () => true,
  ) { this.onChange = onChange; }

  dispose() { this.onChange = () => {}; }

  hasUnsaved() { return [...this.drafts.values()].some((draft) => draft.state !== "saved"); }

  /** Resume only writes that have not been sent, after permissions are verified. */
  resumePending() {
    if (!this.mayWrite()) return;
    for (const [id, draft] of this.drafts) {
      if (draft.state !== "pending") continue;
      draft.state = "saved";
      void this.save(id);
    }
  }

  unsavedDrafts() { return [...this.drafts.values()].filter((draft) => draft.state !== "saved"); }

  get(page: SlidesPage): SlideDraft {
    const current = this.drafts.get(page.id);
    if (current && (current.state !== "saved" || current.page.revision >= page.revision)) {
      // Ordering can change without a content revision. Do not put an older
      // position back into the query cache after a background-only update.
      if (current.state === "saved" && current.page.revision === page.revision && current.page.pos !== page.pos) current.page = { ...current.page, pos: page.pos, updatedAt: page.updatedAt };
      return current;
    }
    if (current) { this.drafts.delete(page.id); this.history.delete(page.id); }
    return { page, content: { title: page.title, body: page.body, background: page.background, layout: page.layout ?? "", notes: page.notes, shapes: page.shapes }, state: "saved" };
  }

  edit(page: SlidesPage, patch: Partial<SlideContent>, group?: string) {
    const current = this.get(page);
    const next: SlideDraft = { ...current, content: { ...current.content, ...patch } };
    if (sameSlideContent(current.content, next.content)) return;
    this.onUserEdit();
    const history = this.history.get(page.id) ?? { undo: [], redo: [], group: null, at: 0 };
    const now = Date.now();
    if (!group || history.group !== group || now - history.at > 1000 || history.redo.length) {
      history.undo.push({ content: current.content });
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
  acceptBackgroundBatch(before: readonly SlidesPage[], after: readonly SlidesPage[], batchId = 0): boolean {
    if (before.length !== after.length || !before.length) return false;
    const pairs = before.map((page, index) => {
      const existing = this.drafts.get(page.id);
      const superseded = !!existing && existing.state === "saved" && existing.page.revision < page.revision;
      const current = !existing || superseded ? { page, content: { title: page.title, body: page.body, background: page.background, layout: page.layout ?? "", notes: page.notes, shapes: page.shapes }, state: "saved" as const } : existing;
      return { page, saved: after[index], current, superseded };
    });
    for (const { page, saved, current } of pairs) {
      if (!saved || saved.id !== page.id || saved.slidesId !== page.slidesId || saved.pos !== page.pos || saved.hidden !== page.hidden || saved.revision !== page.revision + (saved.background === page.background ? 0 : 1) || current.state !== "saved" || current.page.revision !== page.revision || current.page.hidden !== page.hidden || !sameSlideContent(current.content, page) || !sameSlideContent({ ...page, background: saved.background }, saved)) return false;
    }
    for (const { page, saved, current, superseded } of pairs) {
      if (page.background === saved.background) continue;
      if (superseded) this.history.delete(page.id);
      const history = this.history.get(page.id) ?? { undo: [], redo: [], group: null, at: 0 };
      history.undo.push({ content: current.content, batchId }); if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
      history.redo = []; history.group = null; this.history.set(page.id, history);
      this.drafts.set(page.id, { page: saved, content: { title: saved.title, body: saved.body, background: saved.background, layout: saved.layout ?? "", notes: saved.notes, shapes: saved.shapes }, state: "saved" });
    }
    this.onChange(); return true;
  }

  /** A batch can travel only while every page still matches the operation and
   * its per-page history has no newer edits above that operation. */
  canTravelBackgroundBatch(currentPages: readonly SlidesPage[], source: readonly SlidesPage[], target: readonly SlidesPage[], direction: "undo" | "redo", batchId = 0): boolean {
    if (!currentPages.length || currentPages.length !== source.length || source.length !== target.length) return false;
    const sources = new Map(source.map((page) => [page.id, page]));
    const targets = new Map(target.map((page) => [page.id, page]));
    if (sources.size !== source.length || targets.size !== target.length || new Set(currentPages.map((page) => page.id)).size !== currentPages.length) return false;
    let changed = false;
    for (const page of currentPages) {
      const from = sources.get(page.id), to = targets.get(page.id), current = this.get(page);
      if (!from || !to || from.slidesId !== to.slidesId || current.page.slidesId !== from.slidesId || current.state !== "saved" || current.page.hidden !== from.hidden || from.hidden !== to.hidden || !sameSlideContent(current.content, from) || !sameSlideContent({ ...from, background: to.background }, to)) return false;
      if (from.background === to.background) continue;
      changed = true;
      const candidate = this.history.get(page.id)?.[direction].at(-1);
      if (!candidate || candidate.batchId !== batchId || !sameSlideContent(candidate.content, to)) return false;
    }
    return changed;
  }

  /** Apply a server-confirmed batch undo/redo without triggering another write. */
  acceptBackgroundTravel(before: readonly SlidesPage[], after: readonly SlidesPage[], source: readonly SlidesPage[], target: readonly SlidesPage[], direction: "undo" | "redo", batchId = 0): boolean {
    if (before.length !== after.length || !this.canTravelBackgroundBatch(before, source, target, direction, batchId)) return false;
    const targets = new Map(target.map((page) => [page.id, page]));
    for (let index = 0; index < before.length; index++) {
      const page = before[index], saved = after[index], to = targets.get(page.id);
      if (!saved || !to || saved.id !== page.id || saved.slidesId !== page.slidesId || saved.pos !== page.pos || saved.hidden !== page.hidden || saved.background !== to.background || saved.revision !== page.revision + (saved.background === page.background ? 0 : 1) || !sameSlideContent({ ...page, background: saved.background }, saved)) return false;
    }
    for (let index = 0; index < before.length; index++) {
      const page = before[index], saved = after[index];
      if (page.background === saved.background) continue;
      const history = this.history.get(page.id)!;
      const current = this.get(page);
      history[direction].pop();
      const opposite = history[direction === "undo" ? "redo" : "undo"];
      opposite.push({ content: current.content, batchId }); if (opposite.length > HISTORY_LIMIT) opposite.shift();
      history.group = null;
      this.drafts.set(page.id, { page: saved, content: { title: saved.title, body: saved.body, background: saved.background, layout: saved.layout ?? "", notes: saved.notes, shapes: saved.shapes }, state: "saved" });
    }
    this.onChange(); return true;
  }

  isBackgroundHistoryTop(page: SlidesPage, target: SlidesPage, direction: "undo" | "redo", batchId = 0): boolean {
    const current = this.get(page), candidate = this.history.get(page.id)?.[direction].at(-1);
    return current.state === "saved" && current.content.background !== target.background && !!candidate && candidate.batchId === batchId && sameSlideContent(candidate.content, target);
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
    const entry = from.pop();
    if (!entry) return;
    to.push({ content: current.content, batchId: entry.batchId });
    if (to.length > HISTORY_LIMIT) to.shift();
    history.group = null;
    this.apply(page.id, { ...current, content: entry.content });
  }

  private apply(id: number, next: SlideDraft) {
    this.drafts.set(id, next);
    this.onChange();
    if (next.state === "saved") void this.save(id);
  }

  private async save(id: number) {
    const current = this.drafts.get(id);
    if (!current || current.state !== "saved") return;
    if (!this.mayWrite()) { current.state = "pending"; this.onChange(); return; }
    const sent = { ...current.content };
    const base = current.page;
    current.state = "saving";
    this.onChange();
    try {
      const saved = await this.write(base, sent);
      if (saved.id !== id || saved.revision !== base.revision + 1 || saved.hidden !== base.hidden || saved.title !== sent.title || saved.body !== sent.body || saved.background !== sent.background || (saved.layout ?? "") !== (sent.layout ?? "") || saved.notes !== sent.notes || !sameShapes(saved.shapes, sent.shapes)) {
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
