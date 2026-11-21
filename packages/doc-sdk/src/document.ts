import { Doc, idKey, ROOT, Tx, type DocView, type OpId } from "@jiange/collab";
import { buildDocx, buildDocxAsync, docxExportLosses, parseDocx, safeDocxLink, type DocxExportOptions } from "./docx.js";
import { blocksToHtml, parseHtml } from "./html.js";
import { markdownTableRows, parseInline, parseMarkdown, toMarkdown, viewToMarkdown, type MarkdownExportOptions, type MdBlock, type MdSpan } from "./markdown.js";
import { applyTableEdit, bodyBlocks, parseTableData, SOURCE_BLOCK_TYPES, TITLE } from "./model.js";
import { tableDataOf } from "./table-cells.js";

export interface DocOutlineItem {
  id: string;
  level: number;
  text: string;
  blockIndex: number;
  childBlockCount: number;
}

export interface DocBlockSnapshot {
  id: string;
  index: number;
  type: string;
  text: string;
  props: Record<string, string>;
  spans: MdSpan[];
}

export interface DocSuggestion {
  id: string;
  blockId: string;
  op: "replace" | "insert_after" | "delete";
  text?: string;
  blockType?: string;
  author: string;
  status: "pending" | "accepted" | "rejected";
  createdAt: string;
}

export interface DocCommentReply {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface DocComment {
  id: string;
  blockId: string;
  quote?: string;
  author: string;
  body: string;
  resolved: boolean;
  replies: DocCommentReply[];
  createdAt: string;
}

export interface DocDiagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  target: string;
  message: string;
  suggestion?: string;
}

export interface DocInspectOptions {
  detail?: "outline" | "summary" | "full";
  maxTokens?: number;
  focus?: string;
  cursor?: string;
}

export interface DocInspectSummary {
  title: string;
  blockCount: number;
  wordCount: number;
  headingCount: number;
  tableCount: number;
  pendingSuggestions: number;
  openComments: number;
  outline: DocOutlineItem[];
}

export interface DocInspectResult {
  kind: "doc";
  version: number;
  promptText: string;
  summary: DocInspectSummary;
  estimatedTokens: number;
  truncated: boolean;
  nextCursor?: string;
}

export interface DocQueryParams {
  section?: string;
  search?: string;
  blockType?: string;
  limit?: number;
}

export interface DocQueryResult {
  blocks: DocBlockSnapshot[];
  totalMatched: number;
  truncated: boolean;
}

export type DocOp =
  | { op: "setTitle"; title: string }
  | { op: "insertBlock"; type: string; text?: string; markdown?: string; props?: Record<string, string>; afterBlockId?: string | null }
  | { op: "updateBlock"; blockId: string; type?: string; text?: string; markdown?: string; props?: Record<string, string> }
  | { op: "deleteBlock"; blockId: string }
  | { op: "moveBlock"; blockId: string; afterBlockId: string | null }
  | { op: "replaceText"; search: string; replacement: string; caseSensitive?: boolean; skipCodeAndMath?: boolean }
  | { op: "editTableCell"; blockId: string; row: number; col: number; value: string }
  | { op: "addTableRow"; blockId: string; values: string[] }
  | { op: "addSuggestion"; blockId: string; kind: "replace" | "insert_after" | "delete"; text?: string; blockType?: string; author?: string }
  | { op: "resolveSuggestion"; suggestionId: string; decision: "accept" | "reject" }
  | { op: "addComment"; blockId: string; body: string; quote?: string; author?: string };

export interface DocDiff {
  titleChanged?: { before: string; after: string };
  insertedBlocks: string[];
  updatedBlocks: string[];
  deletedBlocks: string[];
  replacements: number;
  notes: string[];
}

export interface DocApplyOptions {
  dryRun?: boolean;
  atomic?: boolean;
  actor?: { kind: "ai" | "user" | "system"; id?: string; reason?: string };
}

export interface DocApplyResult {
  ok: boolean;
  dryRun: boolean;
  appliedCount: number;
  diff: DocDiff;
  diagnostics: DocDiagnostic[];
  undoToken?: string;
  error?: { index: number; code: string; message: string };
}

interface DocUndoRecord {
  token: string;
  before: Uint8Array;
  beforeTitle: string;
  beforeSuggestions: DocSuggestion[];
  beforeComments: DocComment[];
  after: Uint8Array;
  afterTitle: string;
  afterSuggestions: DocSuggestion[];
  afterComments: DocComment[];
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

function countWords(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latin = text.replace(/[\u4e00-\u9fff]/g, " ").trim().split(/\s+/).filter(Boolean).length;
  return cjk + latin;
}

function parseOpId(key: string): OpId | null {
  const m = /^(\d+):(\d+)$/.exec(key.trim());
  return m ? { client: Number(m[1]), clock: Number(m[2]) } : null;
}

function headingLevel(type: string): number {
  const m = /^h([1-9])$/.exec(type);
  return m ? Number(m[1]) : 0;
}

function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Lightweight, zero-DOM, AI-Native Document Facade backed by `@jiange/collab`.
 * Hides CRDT `OpId`/`Tx`/`ROOT` plumbing for standalone & AI workflows while
 * preserving full interoperability with Jiange's collaborative `Doc`.
 */
export class Document {
  private doc: Doc;
  private titleText: string;
  private suggestions: DocSuggestion[] = [];
  private comments: DocComment[] = [];
  private versionCounter = 1;
  private undoStack: DocUndoRecord[] = [];
  private redoStack: DocUndoRecord[] = [];
  private idSeq = 1;

  private constructor(doc: Doc, title = "") {
    this.doc = doc;
    this.titleText = title || (doc.hasBlock(TITLE) ? doc.text(TITLE) : "");
  }

  static create(options: { title?: string; blocks?: MdBlock[]; clientId?: number } = {}): Document {
    const doc = new Doc(options.clientId ?? 1);
    const instance = new Document(doc, options.title ?? "");
    if (options.blocks?.length) {
      const tx = new Tx(doc);
      for (const b of options.blocks) {
        instance.appendMdBlock(tx, b, null, true);
      }
    }
    return instance;
  }

  static fromMarkdown(markdown: string, title?: string, clientId = 1): Document {
    const parsed = parseMarkdown(markdown);
    const inferredTitle = title ?? (parsed[0]?.type === "h1" ? parsed[0].text : "");
    return Document.create({ title: inferredTitle, blocks: parsed, clientId });
  }

  static fromHtml(html: string, title = "", clientId = 1): Document {
    return Document.create({ title, blocks: parseHtml(html), clientId });
  }

  static async fromDocx(bytes: Uint8Array, clientId = 1): Promise<{ document: Document; warnings: string[] }> {
    const imported = await parseDocx(bytes);
    const instance = Document.create({ title: imported.title ?? "", blocks: imported.blocks, clientId });
    if (imported.comments?.length) {
      const bodyIds = bodyBlocks(instance.doc);
      for (const c of imported.comments) {
        const idx = c.blockIndex ?? 0;
        const anchor = bodyIds[Math.min(bodyIds.length - 1, Math.max(0, idx))];
        instance.addComment({ blockId: idKey(anchor), author: c.author, body: c.text, quote: c.quote });
      }
    }
    return { document: instance, warnings: imported.warnings };
  }

  static fromCollabDoc(doc: Doc, title?: string): Document {
    return new Document(doc, title);
  }

  get collabDoc(): Doc { return this.doc; }
  get version(): number { return this.versionCounter; }
  get title(): string { return this.titleText; }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  setTitle(title: string): this {
    this.titleText = title;
    this.versionCounter++;
    return this;
  }

  blocks(): DocBlockSnapshot[] {
    const ids = bodyBlocks(this.doc);
    const viewById = new Map(this.doc.view().blocks.map((b) => [b.id, b]));
    return ids.map((opId, index) => {
      const key = idKey(opId);
      const info = this.doc.blockInfo(opId);
      const text = this.doc.text(opId);
      const spans = viewById.get(key)!.spans;
      return { id: key, index, type: info.type, text, props: { ...info.props }, spans };
    });
  }

  getBlock(blockId: string): DocBlockSnapshot | null {
    return this.blocks().find((b) => b.id === blockId) ?? null;
  }

  insertBlock(spec: { type: string; text?: string; markdown?: string; props?: Record<string, string>; afterBlockId?: string | null }): DocBlockSnapshot {
    const tx = new Tx(this.doc);
    let after: OpId | null = null;
    if (spec.afterBlockId === undefined) {
      const list = bodyBlocks(this.doc);
      after = list.length ? list[list.length - 1] : null;
    } else if (spec.afterBlockId !== null) {
      const parsed = parseOpId(spec.afterBlockId);
      if (!parsed || !this.doc.hasBlock(parsed)) throw new Error(`Block not found: ${spec.afterBlockId}`);
      after = parsed;
    }
    const spans = spec.markdown !== undefined ? parseInline(spec.markdown) : spec.text ? [{ text: spec.text, marks: {} }] : [];
    const created = this.appendMdBlock(
      tx,
      { type: spec.type, text: spans.map((s) => s.text).join(""), props: spec.props ?? {}, spans },
      after,
    );
    this.versionCounter++;
    return this.getBlock(idKey(created))!;
  }

  updateBlock(blockId: string, patch: { type?: string; text?: string; markdown?: string; props?: Record<string, string> }): DocBlockSnapshot {
    const opId = parseOpId(blockId);
    if (!opId || !this.doc.hasBlock(opId)) throw new Error(`Block not found: ${blockId}`);
    const tx = new Tx(this.doc);
    if (patch.type) tx.setProp(opId, "type", patch.type);
    if (patch.props) {
      for (const [k, v] of Object.entries(patch.props)) tx.setProp(opId, k, v);
    }
    if (patch.markdown !== undefined || patch.text !== undefined) {
      const spans = patch.markdown !== undefined ? parseInline(patch.markdown) : patch.text ? [{ text: patch.text, marks: {} }] : [];
      const curLen = this.doc.visibleIds(opId).length;
      if (curLen > 0) tx.delete(opId, 0, curLen);
      this.insertSpans(tx, opId, spans);
    }
    this.versionCounter++;
    return this.getBlock(blockId)!;
  }

  deleteBlock(blockId: string): void {
    const opId = parseOpId(blockId);
    if (!opId || !this.doc.hasBlock(opId)) throw new Error(`Block not found: ${blockId}`);
    const tx = new Tx(this.doc);
    tx.deleteBlock(opId);
    this.versionCounter++;
  }

  moveBlock(blockId: string, afterBlockId: string | null): void {
    const opId = parseOpId(blockId);
    if (!opId || !this.doc.hasBlock(opId)) throw new Error(`Block not found: ${blockId}`);
    let after: OpId | null = null;
    if (afterBlockId !== null) {
      after = parseOpId(afterBlockId);
      if (!after || !this.doc.hasBlock(after)) throw new Error(`Target block not found: ${afterBlockId}`);
    }
    const tx = new Tx(this.doc);
    tx.move(opId, after, ROOT);
    this.versionCounter++;
  }

  /** Mark-preserving find & replace across document blocks (skips code/math/diagram by default). */
  replaceText(search: string, replacement: string, options: { caseSensitive?: boolean; skipCodeAndMath?: boolean } = {}): number {
    if (!search) return 0;
    const skip = options.skipCodeAndMath !== false;
    const caseSensitive = options.caseSensitive !== false;
    const needle = caseSensitive ? search : search.toLowerCase();
    const tx = new Tx(this.doc);
    let count = 0;

    for (const opId of bodyBlocks(this.doc)) {
      const info = this.doc.blockInfo(opId);
      if (skip && (info.type === "code" || SOURCE_BLOCK_TYPES.has(info.type))) continue;
      if (info.type === "table") continue;
      const chars = this.doc.richChars(opId);
      const full = chars.map((c) => c.ch).join("");
      const hay = caseSensitive ? full : full.toLowerCase();
      const positions: number[] = [];
      let pos = 0;
      while (true) {
        const idx = hay.indexOf(needle, pos);
        if (idx < 0) break;
        positions.push(idx);
        pos = idx + needle.length;
      }
      // Replace from back to front so earlier character offsets remain valid, preserving marks of the matched span.
      for (let i = positions.length - 1; i >= 0; i--) {
        const at = positions[i];
        const inheritedMarks = chars[at]?.marks ? { ...chars[at].marks } : {};
        tx.delete(opId, at, at + search.length);
        if (replacement) {
          tx.insert(opId, at, replacement, Array.from(replacement, () => ({ ...inheritedMarks })));
        }
        count++;
      }
    }
    if (count > 0) this.versionCounter++;
    return count;
  }

  outline(): DocOutlineItem[] {
    const all = this.blocks();
    const headings: { id: string; level: number; text: string; blockIndex: number }[] = [];
    all.forEach((b, idx) => {
      const lvl = headingLevel(b.type);
      if (lvl > 0) headings.push({ id: b.id, level: lvl, text: b.text, blockIndex: idx });
    });
    return headings.map((h, i) => {
      let end = all.length;
      for (let j = i + 1; j < headings.length; j++) {
        if (headings[j].level <= h.level) { end = headings[j].blockIndex; break; }
      }
      return { ...h, childBlockCount: Math.max(0, end - h.blockIndex - 1) };
    });
  }

  /** Read a heading section by block ID or case-insensitive heading text match. */
  readSection(headingOrId: string): { heading: DocOutlineItem; blocks: DocBlockSnapshot[]; markdown: string } | null {
    const items = this.outline();
    const q = headingOrId.trim().toLowerCase();
    const hit = items.find((h) => h.id === headingOrId || h.text.trim().toLowerCase() === q)
      ?? items.find((h) => h.text.trim().toLowerCase().includes(q));
    if (!hit) return null;
    const all = this.blocks();
    const slice = all.slice(hit.blockIndex, hit.blockIndex + 1 + hit.childBlockCount);
    const md = toMarkdown(slice.map((b) => ({ type: b.type, text: b.text, props: b.props, spans: b.spans })));
    return { heading: hit, blocks: slice, markdown: md };
  }

  // ---------- Suggestions & Comments ----------

  addSuggestion(input: { blockId: string; op: "replace" | "insert_after" | "delete"; text?: string; blockType?: string; author?: string }): DocSuggestion {
    if (!this.getBlock(input.blockId)) throw new Error(`Block not found: ${input.blockId}`);
    const item: DocSuggestion = {
      id: `sug-${this.idSeq++}`,
      blockId: input.blockId,
      op: input.op,
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.blockType ? { blockType: input.blockType } : {}),
      author: input.author ?? "ai",
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.suggestions.push(item);
    this.versionCounter++;
    return { ...item };
  }

  acceptSuggestion(id: string): boolean {
    const sug = this.suggestions.find((s) => s.id === id && s.status === "pending");
    if (!sug) return false;
    if (sug.op === "delete") this.deleteBlock(sug.blockId);
    else if (sug.op === "replace") this.updateBlock(sug.blockId, { markdown: sug.text ?? "", ...(sug.blockType ? { type: sug.blockType } : {}) });
    else if (sug.op === "insert_after") this.insertBlock({ type: sug.blockType ?? "paragraph", markdown: sug.text ?? "", afterBlockId: sug.blockId });
    sug.status = "accepted";
    this.versionCounter++;
    return true;
  }

  rejectSuggestion(id: string): boolean {
    const sug = this.suggestions.find((s) => s.id === id && s.status === "pending");
    if (!sug) return false;
    sug.status = "rejected";
    this.versionCounter++;
    return true;
  }

  listSuggestions(): DocSuggestion[] { return cloneJson(this.suggestions); }

  addComment(input: { blockId: string; body: string; quote?: string; author?: string }): DocComment {
    if (!this.getBlock(input.blockId)) throw new Error(`Block not found: ${input.blockId}`);
    const c: DocComment = {
      id: `cmt-${this.idSeq++}`,
      blockId: input.blockId,
      ...(input.quote ? { quote: input.quote } : {}),
      author: input.author ?? "ai",
      body: input.body,
      resolved: false,
      replies: [],
      createdAt: new Date().toISOString(),
    };
    this.comments.push(c);
    this.versionCounter++;
    return cloneJson(c);
  }

  replyComment(commentId: string, input: { body: string; author?: string }): DocCommentReply | null {
    const c = this.comments.find((item) => item.id === commentId);
    if (!c) return null;
    const reply: DocCommentReply = { id: `rep-${this.idSeq++}`, author: input.author ?? "ai", body: input.body, createdAt: new Date().toISOString() };
    c.replies.push(reply);
    this.versionCounter++;
    return { ...reply };
  }

  resolveComment(commentId: string, resolved = true): boolean {
    const c = this.comments.find((item) => item.id === commentId);
    if (!c) return false;
    c.resolved = resolved;
    this.versionCounter++;
    return true;
  }

  listComments(): DocComment[] { return cloneJson(this.comments); }

  // ---------- Export & Undo ----------

  toView(): DocView {
    return this.doc.view();
  }

  toMarkdown(options?: MarkdownExportOptions): string {
    return viewToMarkdown(this.doc.view(), options);
  }

  toHtml(): string {
    return blocksToHtml(this.blocks());
  }

  toPlainText(): string {
    const parts: string[] = [];
    if (this.titleText) parts.push(this.titleText);
    for (const b of this.blocks()) {
      if (b.type === "table") {
        const rows = parseTableData(tableDataOf(b.props));
        parts.push(rows.map((r) => r.join("\t")).join("\n"));
      } else if (b.text) {
        parts.push(b.text);
      }
    }
    return parts.join("\n\n");
  }

  toDocx(options: DocxExportOptions = {}): Uint8Array {
    return buildDocx(this.doc.view(), {
      title: this.titleText || undefined,
      comments: this.comments.map((c) => ({
        id: c.id,
        author: c.author,
        date: c.createdAt,
        body: c.body,
        blockId: c.blockId,
        quote: c.quote,
        resolved: c.resolved,
        replies: c.replies.map((r) => ({ author: r.author, date: r.createdAt, body: r.body })),
      })),
      ...options,
    });
  }

  async toDocxAsync(options: DocxExportOptions = {}): Promise<Uint8Array> {
    return buildDocxAsync(this.doc.view(), {
      title: this.titleText || undefined,
      comments: this.comments.map((c) => ({
        id: c.id,
        author: c.author,
        date: c.createdAt,
        body: c.body,
        blockId: c.blockId,
        quote: c.quote,
        resolved: c.resolved,
        replies: c.replies.map((r) => ({ author: r.author, date: r.createdAt, body: r.body })),
      })),
      ...options,
    });
  }

  undo(token?: string): boolean {
    if (!this.undoStack.length) return false;
    if (token && this.undoStack[this.undoStack.length - 1].token !== token) return false;
    const rec = this.undoStack.pop()!;
    this.redoStack.push(rec);
    this.doc = Doc.fromState(this.doc.client, rec.before);
    this.titleText = rec.beforeTitle;
    this.suggestions = cloneJson(rec.beforeSuggestions);
    this.comments = cloneJson(rec.beforeComments);
    this.versionCounter++;
    return true;
  }

  redo(): boolean {
    if (!this.redoStack.length) return false;
    const rec = this.redoStack.pop()!;
    this.undoStack.push(rec);
    this.doc = Doc.fromState(this.doc.client, rec.after);
    this.titleText = rec.afterTitle;
    this.suggestions = cloneJson(rec.afterSuggestions);
    this.comments = cloneJson(rec.afterComments);
    this.versionCounter++;
    return true;
  }

  // ---------- AI-Native Primitives ----------

  inspect(options: DocInspectOptions = {}): DocInspectResult {
    const detail = options.detail ?? "summary";
    const maxTokens = options.maxTokens ?? 2000;
    const all = this.blocks();
    const outline = this.outline();
    const wordCount = all.reduce((sum, b) => sum + countWords(b.text), countWords(this.titleText));
    const tableCount = all.filter((b) => b.type === "table").length;
    const pendingSuggestions = this.suggestions.filter((s) => s.status === "pending").length;
    const openComments = this.comments.filter((c) => !c.resolved).length;

    const lines: string[] = [
      `# Document: ${this.titleText || "(Untitled)"} (v${this.versionCounter}, blocks=${all.length}, words=${wordCount}, tables=${tableCount})`,
    ];
    if (outline.length) {
      lines.push("## Outline");
      for (const h of outline) lines.push(`${"  ".repeat(h.level - 1)}- [${h.id}] H${h.level}: ${h.text} (${h.childBlockCount} blocks)`);
    }

    let truncated = false;
    let nextCursor: string | undefined;
    if (detail !== "outline") {
      let slice = all;
      if (options.focus) {
        const sec = this.readSection(options.focus);
        if (sec) slice = sec.blocks;
      }
      const start = options.cursor ? Math.max(0, Number(options.cursor) || 0) : 0;
      const maxCharsPerBlock = detail === "summary" ? 240 : 4000;
      lines.push("\n## Blocks");
      for (let i = start; i < slice.length; i++) {
        const b = slice[i];
        const preview = b.type === "table"
          ? `[table ${parseTableData(tableDataOf(b.props)).length} rows]`
          : (b.text.length > maxCharsPerBlock ? b.text.slice(0, maxCharsPerBlock) + "…" : b.text);
        const line = `[${b.id}] (${b.type}) ${preview}`;
        if (estimateTokens([...lines, line].join("\n")) > maxTokens && i > start) {
          truncated = true;
          nextCursor = String(i);
          break;
        }
        lines.push(line);
      }
    }

    let promptText = lines.join("\n");
    if (estimateTokens(promptText) > maxTokens) {
      promptText = promptText.slice(0, Math.max(160, Math.floor(maxTokens * 3.5))) + "\n…(truncated)";
      truncated = true;
    }

    return {
      kind: "doc",
      version: this.versionCounter,
      promptText,
      summary: {
        title: this.titleText,
        blockCount: all.length,
        wordCount,
        headingCount: outline.length,
        tableCount,
        pendingSuggestions,
        openComments,
        outline,
      },
      estimatedTokens: estimateTokens(promptText),
      truncated,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  query(params: DocQueryParams = {}): DocQueryResult {
    const limit = Math.min(500, Math.max(1, params.limit ?? 100));
    let pool = this.blocks();
    if (params.section) {
      const sec = this.readSection(params.section);
      pool = sec ? sec.blocks : [];
    }
    const q = params.search?.toLowerCase();
    const matched = pool.filter((b) => {
      if (params.blockType && b.type !== params.blockType) return false;
      if (q && !b.text.toLowerCase().includes(q) && !JSON.stringify(b.props).toLowerCase().includes(q)) return false;
      return true;
    });
    return {
      blocks: matched.slice(0, limit),
      totalMatched: matched.length,
      truncated: matched.length > limit,
    };
  }

  apply(ops: readonly DocOp[], options: DocApplyOptions = {}): DocApplyResult {
    const dryRun = options.dryRun === true;
    const atomic = options.atomic !== false;

    if (dryRun) {
      const clone = new Document(Doc.fromState(this.doc.client, this.doc.encodeState()), this.titleText);
      clone.suggestions = cloneJson(this.suggestions);
      clone.comments = cloneJson(this.comments);
      clone.idSeq = this.idSeq;
      const res = clone.apply(ops, { ...options, dryRun: false });
      return { ...res, dryRun: true, undoToken: undefined };
    }

    const beforeState = this.doc.encodeState();
    const beforeTitle = this.titleText;
    const beforeSuggestions = cloneJson(this.suggestions);
    const beforeComments = cloneJson(this.comments);
    const diff: DocDiff = { insertedBlocks: [], updatedBlocks: [], deletedBlocks: [], replacements: 0, notes: [] };
    let appliedCount = 0;

    try {
      for (const op of ops) {
        this.executeOp(op, diff);
        appliedCount++;
      }
    } catch (err) {
      if (atomic) {
        this.doc = Doc.fromState(this.doc.client, beforeState);
        this.titleText = beforeTitle;
        this.suggestions = beforeSuggestions;
        this.comments = beforeComments;
      }
      return {
        ok: false,
        dryRun: false,
        appliedCount: atomic ? 0 : appliedCount,
        diff: atomic ? { insertedBlocks: [], updatedBlocks: [], deletedBlocks: [], replacements: 0, notes: [] } : diff,
        diagnostics: this.verify(),
        error: { index: appliedCount, code: "op_failed", message: err instanceof Error ? err.message : String(err) },
      };
    }

    const undoToken = `doc-undo-${this.versionCounter}-${Date.now().toString(36)}`;
    this.undoStack.push({
      token: undoToken,
      before: beforeState,
      beforeTitle,
      beforeSuggestions,
      beforeComments,
      after: this.doc.encodeState(),
      afterTitle: this.titleText,
      afterSuggestions: cloneJson(this.suggestions),
      afterComments: cloneJson(this.comments),
    });
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];

    return { ok: true, dryRun: false, appliedCount, diff, diagnostics: this.verify(), undoToken };
  }

  verify(): DocDiagnostic[] {
    const out: DocDiagnostic[] = [];
    const blocks = this.blocks();
    const validIds = new Set(blocks.map((b) => b.id));

    for (const b of blocks) {
      if (b.type === "table" && !markdownTableRows(tableDataOf(b.props))) {
        out.push({ severity: "error", code: "malformed_table", target: `block:${b.id}`, message: "Table block has malformed tableData", suggestion: "Repair props.tableData as a valid rectangular JSON string matrix" });
      }
      for (const span of b.spans) {
        if (span.marks.link && !span.marks.link.startsWith("#/") && !safeDocxLink(span.marks.link)) {
          out.push({ severity: "warning", code: "unsafe_link", target: `block:${b.id}`, message: `Unsupported link protocol: ${span.marks.link}`, suggestion: "Use http:, https:, or mailto: links" });
        }
      }
    }
    for (const s of this.suggestions) {
      if (s.status === "pending" && !validIds.has(s.blockId)) {
        out.push({ severity: "warning", code: "orphan_suggestion", target: `suggestion:${s.id}`, message: `Pending suggestion references deleted block ${s.blockId}` });
      }
    }
    for (const loss of docxExportLosses(this.doc.view())) {
      out.push({ severity: "info", code: "docx_export_loss", target: "document", message: loss });
    }
    return out;
  }

  private executeOp(op: DocOp, diff: DocDiff): void {
    switch (op.op) {
      case "setTitle":
        diff.titleChanged = { before: this.titleText, after: op.title };
        this.setTitle(op.title);
        return;
      case "insertBlock": {
        const created = this.insertBlock(op);
        diff.insertedBlocks.push(created.id);
        return;
      }
      case "updateBlock":
        this.updateBlock(op.blockId, op);
        diff.updatedBlocks.push(op.blockId);
        return;
      case "deleteBlock":
        this.deleteBlock(op.blockId);
        diff.deletedBlocks.push(op.blockId);
        return;
      case "moveBlock":
        this.moveBlock(op.blockId, op.afterBlockId);
        diff.notes.push(`moved:${op.blockId}`);
        return;
      case "replaceText":
        diff.replacements += this.replaceText(op.search, op.replacement, op);
        return;
      case "editTableCell": {
        const blk = this.getBlock(op.blockId);
        if (!blk || blk.type !== "table") throw new Error(`Table block not found: ${op.blockId}`);
        const rows = parseTableData(tableDataOf(blk.props));
        const next = applyTableEdit(rows, op.row, op.col, op.value);
        this.updateBlock(op.blockId, { props: { tableData: JSON.stringify(next) } });
        diff.updatedBlocks.push(op.blockId);
        return;
      }
      case "addTableRow": {
        const blk = this.getBlock(op.blockId);
        if (!blk || blk.type !== "table") throw new Error(`Table block not found: ${op.blockId}`);
        const rows = parseTableData(tableDataOf(blk.props));
        const cols = rows[0].length;
        const padded = Array.from({ length: cols }, (_, i) => op.values[i] ?? "");
        rows.push(padded);
        this.updateBlock(op.blockId, { props: { tableData: JSON.stringify(rows) } });
        diff.updatedBlocks.push(op.blockId);
        return;
      }
      case "addSuggestion": {
        const s = this.addSuggestion({ blockId: op.blockId, op: op.kind, text: op.text, blockType: op.blockType, author: op.author });
        diff.notes.push(`suggestion:${s.id}`);
        return;
      }
      case "resolveSuggestion": {
        const ok = op.decision === "accept" ? this.acceptSuggestion(op.suggestionId) : this.rejectSuggestion(op.suggestionId);
        if (!ok) throw new Error(`Pending suggestion not found: ${op.suggestionId}`);
        diff.notes.push(`suggestion_${op.decision}:${op.suggestionId}`);
        return;
      }
      case "addComment": {
        const c = this.addComment(op);
        diff.notes.push(`comment:${c.id}`);
        return;
      }
    }
  }

  private appendMdBlock(tx: Tx, b: MdBlock, after: OpId | null, appendEnd = false): OpId {
    const type = b.type || "paragraph";
    const id = appendEnd ? this.doc.createBlock(type, ROOT).id : tx.create(type, after, ROOT);
    for (const [k, v] of Object.entries(b.props ?? {})) {
      if (k !== "type" && v !== undefined) tx.setProp(id, k, v);
    }
    const spans = b.spans?.length ? b.spans : (b.text ? [{ text: b.text, marks: {} }] : []);
    this.insertSpans(tx, id, spans);
    return id;
  }

  private insertSpans(tx: Tx, blockId: OpId, spans: readonly MdSpan[]): void {
    let offset = 0;
    for (const span of spans) {
      if (!span.text) continue;
      const marks = span.marks && Object.keys(span.marks).length ? Array.from(span.text, () => ({ ...span.marks })) : undefined;
      offset += tx.insert(blockId, offset, span.text, marks);
    }
  }
}
