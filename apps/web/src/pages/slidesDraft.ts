import { ApiError, type SlidesPage } from "@/lib/api";

export type SlideContent = Pick<SlidesPage, "title" | "body" | "background">;
export type SlideDraft = { page: SlidesPage; content: SlideContent; state: "saved" | "saving" | "conflict" | "unknown" };

/** Serialise writes per page; keep the user's latest text when a write fails. */
export class SlidesDraftQueue {
  private drafts = new Map<number, SlideDraft>();
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
    if (current && (current.state !== "saved" || current.page.revision >= page.revision)) return current;
    if (current) this.drafts.delete(page.id);
    return { page, content: { title: page.title, body: page.body, background: page.background }, state: "saved" };
  }

  edit(page: SlidesPage, patch: Partial<SlideContent>) {
    const current = this.get(page);
    const next: SlideDraft = { ...current, content: { ...current.content, ...patch } };
    this.drafts.set(page.id, next);
    this.onChange();
    if (next.state === "saved") void this.save(page.id);
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
      if (saved.id !== id || saved.revision !== base.revision + 1 || saved.title !== sent.title || saved.body !== sent.body || saved.background !== sent.background) {
        throw new Error("unexpected slide response");
      }
      const latest = this.drafts.get(id);
      if (!latest) return;
      latest.page = saved;
      latest.state = "saved";
      this.onSaved(saved);
      this.onChange();
      if (latest.content.title !== sent.title || latest.content.body !== sent.body || latest.content.background !== sent.background) void this.save(id);
    } catch (error) {
      const latest = this.drafts.get(id);
      if (!latest) return;
      // A lost response may mean the write committed; never blindly replay it.
      latest.state = error instanceof ApiError && error.status === 409 ? "conflict" : "unknown";
      this.onChange();
    }
  }
}
