import type { AgentToolkit, InspectDetail, ToolDefinition } from "./types.js";
import type { Workbook, WorkbookOp } from "./workbook.js";

const SHEET_TOOLS: readonly ToolDefinition[] = [
  {
    name: "sheet_inspect",
    description: "Inspect the workbook structure, sheets, detected headers, sample rows, formula counts, and error counts within a token budget.",
    inputSchema: {
      type: "object",
      properties: {
        detail: { type: "string", enum: ["outline", "summary", "full"], description: "Inspection granularity (default: summary)." },
        maxTokens: { type: "number", description: "Soft token budget (default: 2000)." },
        focus: { type: "string", description: "Optional worksheet name to inspect exclusively." },
        cursor: { type: "string", description: "Continuation cursor from a previous truncated inspect call." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "sheet_query",
    description: "Read a targeted A1 range (e.g. 'Sales!A1:D20') or search cells/formulas/errors without dumping the full workbook.",
    inputSchema: {
      type: "object",
      properties: {
        sheet: { type: "string", description: "Worksheet name (optional if range includes sheet prefix)." },
        range: { type: "string", description: "A1 or A1:B10 range (optionally prefixed with SheetName!)." },
        search: { type: "string", description: "Case-insensitive substring match over raw formula or formatted value." },
        onlyFormulas: { type: "boolean", description: "Return only formula cells." },
        onlyErrors: { type: "boolean", description: "Return only cells evaluating to formula errors." },
        limit: { type: "number", description: "Max cells to return (default: 200, max: 2000)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "sheet_apply",
    description: "Apply a declarative batch of workbook edits atomically, with optional dryRun preview, diff, undo token, and post-apply verification diagnostics.",
    inputSchema: {
      type: "object",
      required: ["ops"],
      properties: {
        ops: {
          type: "array",
          description: "Ordered list of workbook operations (setCells, setRange, clearRange, addSheet, renameSheet, deleteSheet, merge, unmerge, setFreeze, resize, sort, defineName, addValidation, addConditionalFormat, addChart).",
          items: { type: "object", required: ["op"], properties: { op: { type: "string" } } },
        },
        dryRun: { type: "boolean", description: "Preview diff and diagnostics without mutating the workbook." },
        reason: { type: "string", description: "Short audit explanation for this edit batch." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "sheet_verify",
    description: "Run deterministic audit over the entire workbook: formula errors (#REF!, #DIV/0!, #CYCLE!, #SPILL!, etc.), data validation violations, and broken merges/charts/pivots.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "sheet_undo",
    description: "Undo the most recent applied edit batch (or verify an undoToken before rolling back).",
    inputSchema: {
      type: "object",
      properties: { token: { type: "string", description: "Optional undoToken from sheet_apply." } },
      additionalProperties: false,
    },
  },
  {
    name: "sheet_export_csv",
    description: "Export a worksheet's evaluated display values as RFC 4180 CSV.",
    inputSchema: {
      type: "object",
      properties: { sheet: { type: "string", description: "Worksheet name (defaults to first sheet)." } },
      additionalProperties: false,
    },
  },
];

/**
 * Create a self-describing, zero-dependency AI Agent toolkit bound to a `Workbook`.
 * Compatible directly with OpenAI / Gemini / Anthropic function calling and MCP.
 */
export function createSheetTools(workbook: Workbook): AgentToolkit {
  return {
    tools: SHEET_TOOLS,
    execute(name: string, args: Record<string, unknown> = {}): unknown {
      switch (name) {
        case "sheet_inspect":
          return workbook.inspect({
            detail: args.detail as InspectDetail | undefined,
            maxTokens: typeof args.maxTokens === "number" ? args.maxTokens : undefined,
            focus: typeof args.focus === "string" ? args.focus : undefined,
            cursor: typeof args.cursor === "string" ? args.cursor : undefined,
          });
        case "sheet_query":
          return workbook.query({
            sheet: typeof args.sheet === "string" ? args.sheet : undefined,
            range: typeof args.range === "string" ? args.range : undefined,
            search: typeof args.search === "string" ? args.search : undefined,
            onlyFormulas: args.onlyFormulas === true,
            onlyErrors: args.onlyErrors === true,
            limit: typeof args.limit === "number" ? args.limit : undefined,
          });
        case "sheet_apply": {
          if (!Array.isArray(args.ops)) throw new Error("sheet_apply requires an ops array");
          return workbook.apply(args.ops as WorkbookOp[], {
            dryRun: args.dryRun === true,
            actor: { kind: "ai", reason: typeof args.reason === "string" ? args.reason : undefined },
          });
        }
        case "sheet_verify":
          return { ok: true, diagnostics: workbook.verify() };
        case "sheet_undo": {
          const undone = workbook.undo(typeof args.token === "string" ? args.token : undefined);
          return { ok: undone, version: workbook.version };
        }
        case "sheet_export_csv":
          return { csv: workbook.toCsv(typeof args.sheet === "string" ? args.sheet : undefined) };
        default:
          throw new Error(`Unknown sheet tool: ${name}`);
      }
    },
  };
}
