import type { DocInspectOptions, DocOp, Document } from "./document.js";

export interface DocToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface DocAgentToolkit {
  readonly tools: readonly DocToolDefinition[];
  execute(name: string, args?: Record<string, unknown>): unknown;
}

const DOC_TOOLS: readonly DocToolDefinition[] = [
  {
    name: "doc_inspect",
    description: "Inspect document title, heading outline, block stats, and compact preview within a token budget.",
    inputSchema: {
      type: "object",
      properties: {
        detail: { type: "string", enum: ["outline", "summary", "full"] },
        maxTokens: { type: "number" },
        focus: { type: "string", description: "Optional heading text or block ID to focus on." },
        cursor: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "doc_read_section",
    description: "Read a specific heading section (heading + all child blocks) by heading text or block ID.",
    inputSchema: {
      type: "object",
      required: ["section"],
      properties: { section: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "doc_query",
    description: "Search or filter blocks by substring, block type, or heading section.",
    inputSchema: {
      type: "object",
      properties: {
        section: { type: "string" },
        search: { type: "string" },
        blockType: { type: "string" },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "doc_apply",
    description: "Apply an atomic batch of document edits (setTitle, insertBlock, updateBlock, deleteBlock, moveBlock, replaceText, editTableCell, addTableRow, addSuggestion, resolveSuggestion, addComment) with optional dryRun preview.",
    inputSchema: {
      type: "object",
      required: ["ops"],
      properties: {
        ops: { type: "array", items: { type: "object", required: ["op"], properties: { op: { type: "string" } } } },
        dryRun: { type: "boolean" },
        reason: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "doc_verify",
    description: "Audit document integrity: malformed tables, unsafe links, orphan suggestions, and DOCX export loss warnings.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "doc_undo",
    description: "Undo the most recent applied edit batch.",
    inputSchema: {
      type: "object",
      properties: { token: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "doc_export_markdown",
    description: "Export the document to normalized Markdown.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

export function createDocTools(document: Document): DocAgentToolkit {
  return {
    tools: DOC_TOOLS,
    execute(name: string, args: Record<string, unknown> = {}): unknown {
      switch (name) {
        case "doc_inspect":
          return document.inspect({
            detail: args.detail as DocInspectOptions["detail"],
            maxTokens: typeof args.maxTokens === "number" ? args.maxTokens : undefined,
            focus: typeof args.focus === "string" ? args.focus : undefined,
            cursor: typeof args.cursor === "string" ? args.cursor : undefined,
          });
        case "doc_read_section":
          if (typeof args.section !== "string") throw new Error("doc_read_section requires section string");
          return document.readSection(args.section);
        case "doc_query":
          return document.query({
            section: typeof args.section === "string" ? args.section : undefined,
            search: typeof args.search === "string" ? args.search : undefined,
            blockType: typeof args.blockType === "string" ? args.blockType : undefined,
            limit: typeof args.limit === "number" ? args.limit : undefined,
          });
        case "doc_apply":
          if (!Array.isArray(args.ops)) throw new Error("doc_apply requires ops array");
          return document.apply(args.ops as DocOp[], {
            dryRun: args.dryRun === true,
            actor: { kind: "ai", reason: typeof args.reason === "string" ? args.reason : undefined },
          });
        case "doc_verify":
          return { ok: true, diagnostics: document.verify() };
        case "doc_undo":
          return { ok: document.undo(typeof args.token === "string" ? args.token : undefined), version: document.version };
        case "doc_export_markdown":
          return { markdown: document.toMarkdown() };
        default:
          throw new Error(`Unknown doc tool: ${name}`);
      }
    },
  };
}
