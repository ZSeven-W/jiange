/**
 * AI Tool Definitions (JSON Schema) and executor for `@jiange/whiteboard-sdk`.
 */

import { Board, type BoardOp } from "./board.js";
import type { Shape } from "./model.js";

export interface WhiteboardToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface WhiteboardToolRuntime {
  tools: WhiteboardToolDefinition[];
  execute(name: string, args?: Record<string, unknown>): unknown;
}

export function createWhiteboardTools(board: Board): WhiteboardToolRuntime {
  const tools: WhiteboardToolDefinition[] = [
    {
      name: "board_inspect",
      description: "Inspect board summary, nodes, edges, mind map topics, and stroke counts within a token budget.",
      inputSchema: {
        type: "object",
        properties: {
          detail: { type: "string", enum: ["summary", "standard", "full"] },
          maxTokens: { type: "number" },
        },
      },
    },
    {
      name: "board_query",
      description: "Search flowchart nodes, edges, and mind map topics by text, shape, or connectivity.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
          shape: { type: "string" },
          connectedTo: { type: "string" },
        },
      },
    },
    {
      name: "board_apply",
      description: "Atomically apply node, edge, mind map, stroke, or layout mutations with optional dryRun.",
      inputSchema: {
        type: "object",
        required: ["ops"],
        properties: {
          ops: { type: "array", items: { type: "object" } },
          dryRun: { type: "boolean" },
          atomic: { type: "boolean" },
          actor: { type: "string" },
        },
      },
    },
    {
      name: "board_verify",
      description: "Verify board integrity: dangling edges, isolated nodes, overlaps, cycles, and orphan mind topics.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "board_auto_layout",
      description: "Run layered DAG auto-layout on flowchart nodes (TB or LR).",
      inputSchema: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["TB", "LR"] },
          gapX: { type: "number" },
          gapY: { type: "number" },
        },
      },
    },
    {
      name: "board_export",
      description: "Export the board to Mermaid diagram syntax or standalone SVG.",
      inputSchema: {
        type: "object",
        required: ["format"],
        properties: {
          format: { type: "string", enum: ["mermaid", "svg"] },
        },
      },
    },
    {
      name: "board_undo",
      description: "Undo the most recent board mutation.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "board_redo",
      description: "Redo the most recently undone board mutation.",
      inputSchema: { type: "object", properties: {} },
    },
  ];

  const execute = (name: string, args: Record<string, unknown> = {}): unknown => {
    switch (name) {
      case "board_inspect":
        return board.inspect({
          detail: args.detail as "summary" | "standard" | "full" | undefined,
          maxTokens: typeof args.maxTokens === "number" ? args.maxTokens : undefined,
        });
      case "board_query":
        return board.query({
          text: typeof args.text === "string" ? args.text : undefined,
          shape: args.shape as Shape | undefined,
          connectedTo: typeof args.connectedTo === "string" ? args.connectedTo : undefined,
        });
      case "board_apply":
        return board.apply((args.ops as BoardOp[]) ?? [], {
          dryRun: Boolean(args.dryRun),
          atomic: args.atomic === undefined ? true : Boolean(args.atomic),
          actor: typeof args.actor === "string" ? args.actor : undefined,
        });
      case "board_verify":
        return board.verify();
      case "board_auto_layout":
        return board.autoLayout({
          direction: args.direction as "TB" | "LR" | undefined,
          gapX: typeof args.gapX === "number" ? args.gapX : undefined,
          gapY: typeof args.gapY === "number" ? args.gapY : undefined,
        });
      case "board_export": {
        const fmt = args.format === "svg" ? "svg" : "mermaid";
        return { format: fmt, content: fmt === "svg" ? board.toSvg() : board.toMermaid() };
      }
      case "board_undo":
        return { undone: board.undo(), canUndo: board.canUndo(), canRedo: board.canRedo() };
      case "board_redo":
        return { redone: board.redo(), canUndo: board.canUndo(), canRedo: board.canRedo() };
      default:
        throw new Error(`Unknown whiteboard tool: ${name}`);
    }
  };

  return { tools, execute };
}
