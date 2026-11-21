import { IncrementalFormulaEngine } from "./formula-engine.js";
import type { EvalValue, SheetDefinedName, SheetWorksheet } from "./types.js";

export type FormulaWorkerRequest =
  | { id: number; type: "load"; sheets: SheetWorksheet[]; definedNames?: SheetDefinedName[] }
  | { id: number; type: "update"; sheetId: number; changes: { row: number; col: number; raw: string }[] }
  | { id: number; type: "getSheet"; sheetId: number };

export type FormulaWorkerResponse =
  | { id: number; ok: true; type: "load"; values: Record<number, Record<string, EvalValue>> }
  | { id: number; ok: true; type: "update"; sheetId: number; recalculated: number; dirtyKeys: string[]; patch: Record<string, EvalValue> }
  | { id: number; ok: true; type: "getSheet"; sheetId: number; values: Record<string, EvalValue> }
  | { id: number; ok: false; error: string };

export interface MessagePortLike {
  postMessage(message: unknown): void;
  addEventListener?(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener?(type: "message", listener: (event: { data: unknown }) => void): void;
  onmessage?: ((event: { data: unknown }) => void) | null;
}

/**
 * Create a pure handler inside a Web Worker or Node worker_thread.
 * Zero DOM or Node-specific imports so it runs identically in every Worker runtime.
 */
export function createFormulaWorkerHost(): (req: FormulaWorkerRequest) => FormulaWorkerResponse {
  const engine = new IncrementalFormulaEngine();
  return (req: FormulaWorkerRequest): FormulaWorkerResponse => {
    try {
      if (req.type === "load") {
        const all = engine.loadSheets(req.sheets, { definedNames: req.definedNames });
        const values: Record<number, Record<string, EvalValue>> = {};
        for (const [sid, map] of all) values[sid] = map;
        return { id: req.id, ok: true, type: "load", values };
      }
      if (req.type === "update") {
        const res = engine.updateCells(req.sheetId, req.changes);
        const patch: Record<string, EvalValue> = {};
        for (const key of res.dirtyKeys) {
          const [sid, r, c] = key.split(":").map(Number);
          if (sid === req.sheetId) patch[`${r}:${c}`] = engine.getValue(sid, r, c);
        }
        return { id: req.id, ok: true, type: "update", sheetId: req.sheetId, recalculated: res.recalculated, dirtyKeys: res.dirtyKeys, patch };
      }
      if (req.type === "getSheet") {
        return { id: req.id, ok: true, type: "getSheet", sheetId: req.sheetId, values: engine.getSheetValues(req.sheetId) };
      }
      return { id: (req as { id: number }).id, ok: false, error: "Unsupported worker message" };
    } catch (error) {
      return { id: req.id, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
}

/** Main-thread async client talking to a formula Worker over any `MessagePortLike`. */
export class FormulaWorkerClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: FormulaWorkerResponse) => void; reject: (e: Error) => void }>();
  private readonly listener = (event: { data: unknown }) => {
    const msg = event.data as FormulaWorkerResponse | undefined;
    if (!msg || typeof msg.id !== "number") return;
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg);
    else entry.reject(new Error(msg.error));
  };

  constructor(private readonly port: MessagePortLike) {
    if (port.addEventListener) port.addEventListener("message", this.listener);
    else port.onmessage = this.listener;
  }

  private send<T extends FormulaWorkerResponse>(req: FormulaWorkerRequest): Promise<T> {
    return new Promise((resolve, reject) => {
      this.pending.set(req.id, { resolve: resolve as (v: FormulaWorkerResponse) => void, reject });
      this.port.postMessage(req);
    });
  }

  async load(sheets: SheetWorksheet[], definedNames?: SheetDefinedName[]): Promise<Record<number, Record<string, EvalValue>>> {
    const res = await this.send<Extract<FormulaWorkerResponse, { type: "load" }>>({ id: this.nextId++, type: "load", sheets, definedNames });
    return res.values;
  }

  async update(sheetId: number, changes: { row: number; col: number; raw: string }[]): Promise<{ recalculated: number; dirtyKeys: string[]; patch: Record<string, EvalValue> }> {
    const res = await this.send<Extract<FormulaWorkerResponse, { type: "update" }>>({ id: this.nextId++, type: "update", sheetId, changes });
    return { recalculated: res.recalculated, dirtyKeys: res.dirtyKeys, patch: res.patch };
  }

  async getSheet(sheetId: number): Promise<Record<string, EvalValue>> {
    const res = await this.send<Extract<FormulaWorkerResponse, { type: "getSheet" }>>({ id: this.nextId++, type: "getSheet", sheetId });
    return res.values;
  }

  dispose(): void {
    if (this.port.removeEventListener) this.port.removeEventListener("message", this.listener);
    else if (this.port.onmessage === this.listener) this.port.onmessage = null;
    for (const { reject } of this.pending.values()) reject(new Error("FormulaWorkerClient disposed"));
    this.pending.clear();
  }
}
