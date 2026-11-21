/**
 * AI Tool Definitions (JSON Schema) and executor for `@jiange/base-sdk`.
 */

import { Base, type BaseOp } from "./base.js";
import type { DashboardWidget, FilterRule } from "./types.js";

export interface BaseToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface BaseToolRuntime {
  tools: BaseToolDefinition[];
  execute(name: string, args?: Record<string, unknown>): unknown;
}

export function createBaseTools(base: Base): BaseToolRuntime {
  const tools: BaseToolDefinition[] = [
    {
      name: "base_inspect",
      description: "Inspect tables, field schemas, view counts, and sample records within a token budget.",
      inputSchema: {
        type: "object",
        properties: {
          detail: { type: "string", enum: ["summary", "standard", "full"] },
          maxTokens: { type: "number" },
          tableId: { type: "number" },
        },
      },
    },
    {
      name: "base_query",
      description: "Query table records with AND/OR filters, keyword search, multi-column sort, groupBy, and pagination.",
      inputSchema: {
        type: "object",
        properties: {
          tableId: { type: "number" },
          search: { type: "string" },
          filters: { type: "object" },
          sorts: { type: "array", items: { type: "object" } },
          groupBy: { type: "number" },
          limit: { type: "number" },
          offset: { type: "number" },
        },
      },
    },
    {
      name: "base_apply",
      description: "Atomically apply schema or record mutations (tables, fields, records, views) with dryRun preview.",
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
      name: "base_verify",
      description: "Verify base schema, formulas, cycles, link/lookup integrity, and select options.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "base_dashboard",
      description: "Compute dashboard metric cards and grouped chart aggregations for a table.",
      inputSchema: {
        type: "object",
        properties: {
          tableId: { type: "number" },
          widgets: { type: "array", items: { type: "object" } },
        },
      },
    },
    {
      name: "base_export_csv",
      description: "Export a table (including computed formulas and lookups) as RFC 4180 CSV or TSV.",
      inputSchema: {
        type: "object",
        properties: {
          tableId: { type: "number" },
          delimiter: { type: "string" },
        },
      },
    },
    {
      name: "base_undo",
      description: "Undo the most recent base mutation batch.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "base_redo",
      description: "Redo the most recently undone base mutation batch.",
      inputSchema: { type: "object", properties: {} },
    },
  ];

  const execute = (name: string, args: Record<string, unknown> = {}): unknown => {
    switch (name) {
      case "base_inspect":
        return base.inspect({
          detail: args.detail as "summary" | "standard" | "full" | undefined,
          maxTokens: typeof args.maxTokens === "number" ? args.maxTokens : undefined,
          tableId: typeof args.tableId === "number" ? args.tableId : undefined,
        });
      case "base_query":
        return base.query({
          tableId: typeof args.tableId === "number" ? args.tableId : undefined,
          search: typeof args.search === "string" ? args.search : undefined,
          filters: args.filters as { conj: "and" | "or"; rules: FilterRule[] } | undefined,
          sorts: args.sorts as Array<{ f: number; asc: boolean }> | undefined,
          groupBy: typeof args.groupBy === "number" ? args.groupBy : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
          offset: typeof args.offset === "number" ? args.offset : undefined,
        });
      case "base_apply":
        return base.apply((args.ops as BaseOp[]) ?? [], {
          dryRun: Boolean(args.dryRun),
          atomic: args.atomic === undefined ? true : Boolean(args.atomic),
          actor: typeof args.actor === "string" ? args.actor : undefined,
        });
      case "base_verify":
        return base.verify();
      case "base_dashboard":
        return base.evaluateDashboard(
          args.widgets as DashboardWidget[] | undefined,
          typeof args.tableId === "number" ? args.tableId : undefined,
        );
      case "base_export_csv":
        return {
          csv: base.toCsv(
            typeof args.tableId === "number" ? args.tableId : undefined,
            typeof args.delimiter === "string" ? args.delimiter : ",",
          ),
        };
      case "base_undo":
        return { undone: base.undo(), canUndo: base.canUndo(), canRedo: base.canRedo() };
      case "base_redo":
        return { redone: base.redo(), canUndo: base.canUndo(), canRedo: base.canRedo() };
      default:
        throw new Error(`Unknown base tool: ${name}`);
    }
  };

  return { tools, execute };
}
