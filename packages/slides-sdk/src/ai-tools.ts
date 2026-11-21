/**
 * AI Tool Definitions (JSON Schema) and executor for `@jiange/slides-sdk`.
 * Compatible with OpenAI, Anthropic, Gemini, Vercel AI SDK, and MCP.
 */

import { Presentation, type SlideOp } from "./deck.js";
import type { SlideLayout, SlideShapeKind } from "./model.js";

export interface SlidesToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface SlidesToolRuntime {
  tools: SlidesToolDefinition[];
  execute(name: string, args?: Record<string, unknown>): unknown;
}

export function createSlidesTools(deck: Presentation): SlidesToolRuntime {
  const tools: SlidesToolDefinition[] = [
    {
      name: "slides_inspect",
      description: "Inspect presentation outline, theme, slide counts, and optional per-slide shape details.",
      inputSchema: {
        type: "object",
        properties: {
          detail: { type: "string", enum: ["summary", "standard", "full"] },
          maxTokens: { type: "number" },
          slideIndex: { type: "number" },
        },
      },
    },
    {
      name: "slides_query",
      description: "Search slides by text keyword, layout, hidden flag, or shape kind.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
          layout: { type: "string", enum: ["", "title", "blank", "blank-title"] },
          hidden: { type: "boolean" },
          shapeKind: { type: "string" },
        },
      },
    },
    {
      name: "slides_apply",
      description: "Atomically apply a batch of slide/shape mutations with optional dryRun preview and undoToken.",
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
      name: "slides_verify",
      description: "Run visual & structural diagnostics (text overflow, shape overlap, out-of-bounds, WCAG contrast, missing media).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "slides_render_svg",
      description: "Render a slide (by 0-based slideIndex) to a deterministic 16:9 SVG string.",
      inputSchema: {
        type: "object",
        required: ["slideIndex"],
        properties: {
          slideIndex: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
        },
      },
    },
    {
      name: "slides_undo",
      description: "Undo the most recent applied slide batch.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "slides_redo",
      description: "Redo the most recently undone slide batch.",
      inputSchema: { type: "object", properties: {} },
    },
  ];

  const execute = (name: string, args: Record<string, unknown> = {}): unknown => {
    switch (name) {
      case "slides_inspect":
        return deck.inspect({
          detail: args.detail as "summary" | "standard" | "full" | undefined,
          maxTokens: typeof args.maxTokens === "number" ? args.maxTokens : undefined,
          slideIndex: typeof args.slideIndex === "number" ? args.slideIndex : undefined,
        });
      case "slides_query":
        return deck.query({
          text: typeof args.text === "string" ? args.text : undefined,
          layout: args.layout as SlideLayout | undefined,
          hidden: typeof args.hidden === "boolean" ? args.hidden : undefined,
          shapeKind: args.shapeKind as SlideShapeKind | undefined,
        });
      case "slides_apply":
        return deck.apply((args.ops as SlideOp[]) ?? [], {
          dryRun: Boolean(args.dryRun),
          atomic: args.atomic === undefined ? true : Boolean(args.atomic),
          actor: typeof args.actor === "string" ? args.actor : undefined,
        });
      case "slides_verify":
        return deck.verify();
      case "slides_render_svg":
        return {
          svg: deck.renderSvg(Number(args.slideIndex ?? 0), {
            width: typeof args.width === "number" ? args.width : undefined,
            height: typeof args.height === "number" ? args.height : undefined,
          }),
        };
      case "slides_undo":
        return { undone: deck.undo(), canUndo: deck.canUndo(), canRedo: deck.canRedo() };
      case "slides_redo":
        return { redone: deck.redo(), canUndo: deck.canUndo(), canRedo: deck.canRedo() };
      default:
        throw new Error(`Unknown slides tool: ${name}`);
    }
  };

  return { tools, execute };
}
