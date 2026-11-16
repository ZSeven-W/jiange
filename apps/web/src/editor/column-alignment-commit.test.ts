import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeOps, Doc, encodeOps, ROOT, Tx, UndoManager, type Op } from "@jiange/collab";
import { queryConditionalOpsStatus } from "@/lib/api";
import { ConditionalJournal, type ConditionalAttempt, type ConditionalJournalEnvironment, type ConditionalObservation } from "@/lib/conditional-journal";
import { ColumnAlignmentCommit } from "./column-alignment-commit";
import { ColumnAlignmentHistory } from "./column-alignment-history";

class StorageMock implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}
class LocksMock {
  private held = new Set<string>();
  async request<T>(name: string, _options: unknown, callback: (lock: object | null) => Promise<T>): Promise<T> {
    if (this.held.has(name)) return callback(null);
    this.held.add(name); try { return await callback({}); } finally { this.held.delete(name); }
  }
}
const requestId = "0123456789abcdef0123456789abcdef";
const op: Extract<Op, {t:"bset"}> = {t:"bset",id:{client:9,clock:4},block:{client:3,clock:2},key:"align",value:"left"};
const signal = () => new AbortController().signal;
const hash = async (value: Uint8Array) => new Uint8Array(await webcrypto.subtle.digest("SHA-256", Uint8Array.from(value).buffer));
function setup() {
  const storage = new StorageMock(), locks = new LocksMock();
  const env: ConditionalJournalEnvironment = { storage, locks: locks as unknown as Pick<LockManager, "request">, random: () => requestId, digest: hash };
  const journal = new ConditionalJournal(env, 7, 2);
  let observed: ConditionalObservation = {docId:7,userId:2,epoch:2,lastSeq:3,caughtUp:true,blocked:null,unacked:0};
  let active = true, state: "unknown" | "committed" = "unknown", head = 3;
  const send = vi.fn(async (_attempt: ConditionalAttempt, _bytes: Uint8Array, _signal: AbortSignal) => {});
  const status = vi.fn(async (attempt: ConditionalAttempt) => {
    const payload = state === "unknown" ? {docId:7,userId:2,requestId,state,currentEpoch:2,currentHead:head} : {docId:7,userId:2,requestId,state,currentEpoch:2,currentHead:head,historyEpoch:2,expectedSeq:3,firstSeq:4,opCount:1,digest:attempt.digest};
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), {status:200})));
    return queryConditionalOpsStatus({docId:7,userId:2,requestId,signal:signal()});
  });
  const commit = new ColumnAlignmentCommit(journal, { active: () => active, observe: () => observed }, {send,status});
  return {env,journal,commit,send,status,setObserved:(value:Partial<ConditionalObservation>)=>{observed={...observed,...value};},setActive:(value:boolean)=>{active=value;},setStatus:(value:"unknown"|"committed", nextHead:number)=>{state=value;head=nextHead;}};
}
afterEach(() => vi.unstubAllGlobals());

describe("conditional column alignment request", () => {
  it("accepts only bounded same-document column move operations", async () => {
    const ctx = setup();
    const move: Extract<Op, {t:"bmove"}> = {t:"bmove",id:{client:9,clock:4},block:{client:3,clock:2},parent:{client:3,clock:1},pos:"V"};
    expect(await ctx.commit.start(move,2,3,signal())).toBe("sent");
    const invalid = setup();
    for (const bad of [{...move,pos:"A0"},{...move,pos:"../bad"},{...move,parent:{client:0,clock:0}},{...move,parent:move.block}]) {
      await expect(invalid.commit.start(bad,2,3,signal())).rejects.toThrow(/invalid column layout/);
    }
    expect(invalid.send).not.toHaveBeenCalled();
  });
  it("accepts bounded width metadata but refuses arbitrary text as a layout operation", async () => {
    const ctx = setup();
    const widths: Extract<Op, {t:"bset"}> = {...op, key:"columnWidths", value:'{"3:2":1400,"3:3":600}'};
    expect(await ctx.commit.start(widths,2,3,signal())).toBe("sent");
    expect(ctx.send.mock.calls[0][1]).toEqual(encodeOps([widths]));
    const invalid = setup();
    await expect(invalid.commit.start({...widths, value:'{"3:2":"正文"}'},2,3,signal())).rejects.toThrow(/invalid column layout/);
    expect(invalid.send).not.toHaveBeenCalled(); expect(await invalid.journal.read()).toBeNull();
  });
  it("finishes the captured undo history only after its receipt and operation are observed", async () => {
    const ctx = setup(), doc = new Doc(9), init = new Tx(doc);
    const parent = init.create("columns", null, ROOT), block = init.create("paragraph", null, parent);
    const history = new ColumnAlignmentHistory(), undo = new UndoManager(), before = history.capture(doc, block)!;
    new Tx(doc).setProp(block, "align", "center"); history.record(doc, undo, block, before);
    const marker = undo.peekMarker(false)!;
    const prepared = history.prepareConditional(doc, undo, marker, false);
    expect(prepared.status).toBe("ready"); if (prepared.status !== "ready") return;
    ctx.send.mockImplementation(async (_attempt, bytes) => { doc.apply(decodeOps(bytes)[0]); ctx.setObserved({lastSeq:4}); ctx.setStatus("committed",4); });
    expect(await ctx.commit.start(prepared.plan.op,2,3,signal(),()=>history.canSubmitConditional(doc, undo, prepared.plan))).toBe("sent");
    expect(undo.peekMarker(false)).toBe(marker);
    expect(await ctx.commit.finish(signal(),()=>history.finishConditional(doc, undo, prepared.plan) === "ready")).toBe("committed");
    expect(undo.peekMarker(true)).toBe(marker);
    expect(doc.blockInfo(block).props.align).toBe("");
    expect(await ctx.journal.read()).toBeNull();
  });
  it("persists the request before sending and never duplicates an unresolved attempt", async () => {
    const ctx = setup();
    ctx.send.mockImplementation(async (attempt, bytes) => { expect((await ctx.journal.read())?.requestId).toBe(attempt.requestId); expect(bytes).toEqual(encodeOps([op])); });
    expect(await ctx.commit.start(op,2,3,signal())).toBe("sent");
    expect(await ctx.commit.start(op,2,3,signal())).toBe("occupied");
    expect(ctx.send).toHaveBeenCalledTimes(1);
  });
  it("keeps an uncertain submission and retries only the identical request", async () => {
    const ctx = setup(); ctx.send.mockRejectedValueOnce(new TypeError("network"));
    expect(await ctx.commit.start(op,2,3,signal())).toBe("pending");
    const saved = await ctx.journal.read();
    expect(await ctx.commit.retry(signal())).toBe("sent");
    expect(ctx.send.mock.calls[1][0].requestId).toBe(saved?.requestId);
    expect(ctx.send.mock.calls[1][1]).toEqual(encodeOps([op]));
    ctx.setStatus("committed",4); ctx.setObserved({lastSeq:4});
    expect(await ctx.commit.finish(signal(),()=>false)).toBe("needs_finalize");
    expect(await ctx.journal.read()).not.toBeNull();
    expect(await ctx.commit.finish(signal(),()=>true)).toBe("committed");
    expect(await ctx.journal.read()).toBeNull();
  });
  it("does not clear an acknowledged receipt before the replica observes it", async () => {
    const ctx = setup(); await ctx.commit.start(op,2,3,signal()); ctx.setStatus("committed",4);
    const finalize = vi.fn(()=>true);
    expect(await ctx.commit.finish(signal(),finalize)).toBe("pending");
    expect(finalize).not.toHaveBeenCalled();
    ctx.setObserved({lastSeq:4,unacked:1});
    expect(await ctx.commit.finish(signal(),finalize)).toBe("pending");
    ctx.setObserved({unacked:0});
    expect(await ctx.commit.finish(signal(),finalize)).toBe("committed");
  });
  it("does not retry once another operation advanced the head", async () => {
    const ctx = setup(); ctx.send.mockRejectedValueOnce(new TypeError("network"));
    await ctx.commit.start(op,2,3,signal()); ctx.setStatus("unknown",4); ctx.setObserved({lastSeq:4});
    expect(await ctx.commit.retry(signal())).toBe("needs_resolution");
    expect(ctx.send).toHaveBeenCalledTimes(1);
    expect(await ctx.commit.finish(signal(),()=>{ throw new Error("must not finalize"); })).toBe("not_committed");
    expect(await ctx.journal.read()).toBeNull();
  });
  it("does not submit after the account or synchronization state changes during persistence", async () => {
    const ctx = setup();
    ctx.env.digest = async (bytes) => { ctx.setObserved({lastSeq:4}); return hash(bytes); };
    expect(await ctx.commit.start(op,2,3,signal())).toBe("blocked");
    expect(ctx.send).not.toHaveBeenCalled(); expect(await ctx.journal.read()).toBeNull();
    ctx.setActive(false);
    expect(await ctx.commit.retry(signal())).toBe("blocked");
    expect(await ctx.commit.finish(signal(),()=>true)).toBe("empty");
  });
  it("does not submit if the captured undo action changes while the request is persisted", async () => {
    const ctx = setup(); let valid = true;
    ctx.env.digest = async (bytes) => { valid = false; return hash(bytes); };
    expect(await ctx.commit.start(op,2,3,signal(),()=>valid)).toBe("blocked");
    expect(ctx.send).not.toHaveBeenCalled(); expect(await ctx.journal.read()).toBeNull();
    expect(await ctx.commit.retry(signal(),()=>false)).toBe("blocked");
    expect(ctx.send).not.toHaveBeenCalled();
  });
  it("does not send or clear another conditional feature's journal entry", async () => {
    const ctx = setup();
    const other: Op = {t:"tins",id:{client:9,clock:4},block:{client:0,clock:2},parent:{client:0,clock:0},side:1,text:"私有内容"};
    await ctx.journal.run((lease)=>lease.prepare({historyEpoch:2,expectedSeq:3,batch:encodeOps([other]),allowPersist:true}));
    expect(await ctx.commit.retry(signal())).toBe("occupied");
    expect(await ctx.commit.finish(signal(),()=>true)).toBe("blocked");
    expect(ctx.send).not.toHaveBeenCalled(); expect(await ctx.journal.read()).not.toBeNull();
  });
});
