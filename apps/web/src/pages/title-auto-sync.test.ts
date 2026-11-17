import { afterEach, describe, expect, it, vi } from "vitest";
import { TitleAutoSync, TitleSyncReadError, titleSyncStorageKey, type TitleSyncPoint, type TitleSyncStorage, type TitleSyncTransport } from "./title-auto-sync";

afterEach(() => vi.useRealTimers());

function fixture() {
  let point: TitleSyncPoint | null = { epoch: 4, head: 7, historyRevision: 0, title: "新标题" };
  const commit = vi.fn<TitleSyncTransport["commit"]>().mockResolvedValue(204);
  const read = vi.fn<TitleSyncTransport["read"]>().mockResolvedValue({ historyEpoch: 4, head: 7, directoryTitle: "原标题", documentTitle: "新标题", differs: true });
  const committed = vi.fn();
  const sync = new TitleAutoSync(() => point, { commit, read }, committed);
  return { sync, commit, read, committed, setPoint: (value: TitleSyncPoint | null) => { point = value; } };
}

describe("guarded directory-name synchronization", () => {
  it("waits for a synchronized replica and commits the originally observed directory name", async () => {
    const f = fixture(); f.setPoint(null); f.sync.edit("原标题", 4, 0);
    expect(await f.sync.step()).toBe("waiting"); expect(f.commit).not.toHaveBeenCalled();
    f.setPoint({ epoch: 4, head: 7, historyRevision: 0, title: "新标题" });
    expect(await f.sync.step()).toBe("done");
    expect(f.commit).toHaveBeenCalledWith({ historyEpoch: 4, head: 7, directoryTitle: "原标题", documentTitle: "新标题" }, expect.any(AbortSignal));
    expect(f.committed).toHaveBeenCalledOnce(); expect(f.sync.hasPending).toBe(false);
  });

  it("does not overwrite a later rename and keeps the conflict through further typing", async () => {
    const f = fixture(); f.sync.edit("原标题", 4, 0); f.commit.mockResolvedValueOnce(409);
    f.read.mockResolvedValueOnce({ historyEpoch: 4, head: 7, directoryTitle: "他人的名称", documentTitle: "新标题", differs: true });
    expect(await f.sync.step()).toBe("conflict");
    f.sync.edit("他人的名称", 4, 0); f.setPoint({ epoch: 4, head: 8, historyRevision: 0, title: "继续输入" });
    expect(await f.sync.step()).toBe("conflict"); expect(f.commit).toHaveBeenCalledTimes(1);
    f.sync.clearIfCurrent("继续输入"); expect(f.sync.hasPending).toBe(false);
  });

  it("checks the server even when the edited title equals the original directory name", async () => {
    const f = fixture(); f.sync.edit("原标题", 4, 0); f.setPoint({ epoch: 4, head: 8, historyRevision: 0, title: "原标题" });
    f.commit.mockResolvedValueOnce(409);
    f.read.mockResolvedValueOnce({ historyEpoch: 4, head: 8, directoryTitle: "其他人的名称", documentTitle: "原标题", differs: true });
    expect(await f.sync.step()).toBe("conflict"); expect(f.commit).toHaveBeenCalledOnce();
  });

  it("stops instead of replaying an ambiguous write over another directory rename", async () => {
    const f = fixture(); f.sync.edit("原标题", 4, 0); f.commit.mockRejectedValueOnce(new Error("lost response"));
    expect(await f.sync.step()).toBe("retry");
    f.read.mockResolvedValueOnce({ historyEpoch: 4, head: 7, directoryTitle: "他人的新名称", documentTitle: "新标题", differs: true });
    expect(await f.sync.step()).toBe("conflict"); expect(f.commit).toHaveBeenCalledTimes(1);
  });

  it("treats a timed-out write as uncertain and checks it before retrying", async () => {
    vi.useFakeTimers();
    const f = fixture(); f.sync.edit("原标题", 4, 0);
    f.commit.mockImplementationOnce((_snapshot, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true })));
    const attempt = f.sync.step(); await vi.advanceTimersByTimeAsync(10_000);
    expect(await attempt).toBe("retry");
    f.read.mockResolvedValueOnce({ historyEpoch: 4, head: 7, directoryTitle: "新标题", documentTitle: "新标题", differs: false });
    expect(await f.sync.step()).toBe("done"); expect(f.commit).toHaveBeenCalledTimes(1);
  });

  it("reports revoked access while checking an uncertain write", async () => {
    const f = fixture(); f.sync.edit("原标题", 4, 0); f.commit.mockRejectedValueOnce(new Error("lost response"));
    expect(await f.sync.step()).toBe("retry"); f.read.mockRejectedValueOnce(new TitleSyncReadError(403));
    expect(await f.sync.step()).toBe("denied"); expect(f.sync.hasPending).toBe(true);
  });

  it("retries a head conflict only after checking that the directory name was not changed", async () => {
    const f = fixture(); f.sync.edit("原标题", 4, 0); f.commit.mockResolvedValueOnce(409);
    expect(await f.sync.step()).toBe("retry");
    f.setPoint({ epoch: 4, head: 8, historyRevision: 0, title: "并发合并标题" });
    expect(await f.sync.step()).toBe("done");
    expect(f.commit.mock.calls[1][0]).toEqual({ historyEpoch: 4, head: 8, directoryTitle: "原标题", documentTitle: "并发合并标题" });
  });

  it("checks an ambiguous write before sending anything else", async () => {
    const f = fixture(); f.sync.edit("原标题", 4, 0); f.commit.mockRejectedValueOnce(new TypeError("lost response"));
    expect(await f.sync.step()).toBe("retry");
    f.read.mockResolvedValueOnce({ historyEpoch: 4, head: 7, directoryTitle: "新标题", documentTitle: "新标题", differs: false });
    expect(await f.sync.step()).toBe("done");
    expect(f.commit).toHaveBeenCalledTimes(1); expect(f.committed).toHaveBeenCalledOnce();
  });

  it("uses the confirmed previous name when the user continues editing in flight", async () => {
    const f = fixture(); f.sync.edit("原标题", 4, 0); let finish!: (status: number) => void;
    f.commit.mockImplementationOnce(() => new Promise<number>((resolve) => { finish = resolve; }));
    const first = f.sync.step(); f.setPoint({ epoch: 4, head: 8, historyRevision: 0, title: "更新后的标题" }); f.sync.edit("原标题", 4, 0); finish(204);
    expect(await first).toBe("waiting");
    expect(await f.sync.step()).toBe("done");
    expect(f.commit.mock.calls[1][0]).toEqual({ historyEpoch: 4, head: 8, directoryTitle: "新标题", documentTitle: "更新后的标题" });
  });

  it("does not resend after a successful write while metadata is revalidated", async () => {
    const f = fixture(); f.sync.edit("原标题", 4, 0);
    f.committed.mockImplementationOnce(() => f.setPoint(null));
    expect(await f.sync.step()).toBe("waiting");
    f.setPoint({ epoch: 4, head: 7, historyRevision: 0, title: "新标题" });
    expect(await f.sync.step()).toBe("done"); expect(f.commit).toHaveBeenCalledTimes(1);
  });

  it("never writes invalid titles or after disposal", async () => {
    const f = fixture(); f.sync.edit("原标题", 4, 0); f.setPoint({ epoch: 4, head: 7, historyRevision: 0, title: " 带空格" });
    expect(await f.sync.step()).toBe("invalid"); f.setPoint({ epoch: 4, head: 7, historyRevision: 0, title: "长".repeat(201) });
    expect(await f.sync.step()).toBe("invalid"); f.sync.dispose();
    expect(await f.sync.step()).toBe("done"); expect(f.commit).not.toHaveBeenCalled();
  });

  it("does not accept an unrelated epoch when checking an uncertain request", async () => {
    const f = fixture(); f.sync.edit("原标题", 4, 0); f.commit.mockRejectedValueOnce(new Error("lost")); await f.sync.step();
    f.read.mockResolvedValueOnce({ historyEpoch: 5, head: 7, directoryTitle: "新标题", documentTitle: "新标题", differs: false });
    expect(await f.sync.step()).toBe("history_changed"); expect(f.sync.hasPending).toBe(true); expect(f.committed).not.toHaveBeenCalled();
  });

  it("retains the pending intent when history changes while a write is in flight", async () => {
    const f = fixture(); f.sync.edit("原标题", 4, 0); let finish!: (status: number) => void;
    f.commit.mockImplementationOnce(() => new Promise<number>((resolve) => { finish = resolve; }));
    const pending = f.sync.step(); f.setPoint({ epoch: 5, head: 7, historyRevision: 1, title: "新标题" }); finish(204);
    expect(await pending).toBe("history_changed"); expect(f.sync.hasPending).toBe(true);
    expect(await f.sync.step()).toBe("history_changed"); expect(f.commit).toHaveBeenCalledTimes(1);
  });
});


describe("title sync recovery in the same tab", () => {
  function setup() {
    const data = new Map<string, string>();
    const storage: TitleSyncStorage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); } };
    const point: TitleSyncPoint = { epoch: 4, head: 7, historyRevision: 0, title: "新标题" };
    const commit = vi.fn<TitleSyncTransport["commit"]>().mockResolvedValue(204);
    const read = vi.fn<TitleSyncTransport["read"]>().mockResolvedValue({ historyEpoch: 4, head: 7, directoryTitle: "原标题", documentTitle: "新标题", differs: true });
    const make = (user = 2, doc = 3) => new TitleAutoSync(() => point, { commit, read }, () => {}, { storage, key: titleSyncStorageKey(user, doc) });
    return { data, storage, point, commit, read, make };
  }
  it("restores the pending title after reload and clears it only after confirmation", async () => {
    const f = setup(), first = f.make(); first.edit("原标题", 4, 0, "新标题"); first.dispose();
    const next = f.make(); next.activate(); expect(next.hasPending).toBe(true);
    expect(await next.step()).toBe("done"); expect(f.commit).toHaveBeenCalledOnce(); expect(f.data.size).toBe(0);
  });
  it("reads an in-flight request after reload before deciding whether to retry", async () => {
    const f = setup(), first = f.make(); first.edit("原标题", 4, 0, "新标题");
    f.commit.mockImplementationOnce((_snapshot, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
    const inflight = first.step(); first.dispose(); await inflight;
    f.read.mockResolvedValueOnce({ historyEpoch: 4, head: 7, directoryTitle: "新标题", documentTitle: "新标题", differs: false });
    const next = f.make(); next.activate(); expect(await next.step()).toBe("done");
    expect(f.commit).toHaveBeenCalledTimes(1); expect(f.read).toHaveBeenCalledOnce(); expect(f.data.size).toBe(0);
  });
  it("never overwrites a changed title, directory name or history after recovery", async () => {
    const f = setup(), first = f.make(); first.edit("原标题", 4, 0, "新标题"); first.dispose();
    f.point.title = "其他人的文档标题"; const next = f.make(); next.activate();
    expect(await next.step()).toBe("conflict"); expect(f.commit).not.toHaveBeenCalled();
    next.dispose(); f.point.title = "新标题"; const retry = f.make(); retry.activate(); expect(await retry.step()).toBe("conflict");
    const g = setup(), other = g.make(); other.edit("原标题", 4, 0, "新标题"); other.dispose(); g.point.epoch = 5;
    const restored = g.make(); restored.activate(); expect(await restored.step()).toBe("history_changed"); expect(g.commit).not.toHaveBeenCalled();
  });
  it("keeps another actor's renamed directory after reload", async () => {
    const f = setup(), first = f.make(); first.edit("原标题", 4, 0, "新标题"); first.dispose();
    f.commit.mockResolvedValueOnce(409);
    f.read.mockResolvedValueOnce({ historyEpoch: 4, head: 7, directoryTitle: "其他人的目录名", documentTitle: "新标题", differs: true });
    const restored = f.make(); restored.activate(); expect(await restored.step()).toBe("conflict");
    expect(f.commit).toHaveBeenCalledTimes(1); expect(restored.hasPending).toBe(true);
    restored.dispose(); const again = f.make(); again.activate(); expect(await again.step()).toBe("conflict"); expect(f.commit).toHaveBeenCalledTimes(1);
  });
  it("does not treat an in-memory history counter from before reload as durable evidence", async () => {
    const f = setup(), first = f.make(); first.edit("原标题", 4, 3, "新标题"); first.dispose();
    const restored = f.make(); restored.activate(); f.point.historyRevision = 3;
    expect(await restored.step()).toBe("history_changed"); expect(f.commit).not.toHaveBeenCalled();
  });
  it("scopes recovery to account and document, and ignores corrupt storage", () => {
    const f = setup(), first = f.make(); first.edit("原标题", 4, 0, "新标题"); first.dispose();
    const otherUser = f.make(9, 3), otherDoc = f.make(2, 9); otherUser.activate(); otherDoc.activate();
    expect(otherUser.hasPending || otherDoc.hasPending).toBe(false);
    f.data.set(titleSyncStorageKey(2, 3), '{"pending":{"baseline":2}}');
    const invalid = f.make(); invalid.activate(); expect(invalid.hasPending).toBe(false);
  });
  it("keeps normal in-memory synchronization if storage throws", async () => {
    const f = setup(); const unavailable: TitleSyncStorage = { getItem: () => { throw Error(); }, setItem: () => { throw Error(); }, removeItem: () => { throw Error(); } };
    const sync = new TitleAutoSync(() => f.point, { commit: f.commit, read: f.read }, () => {}, { storage: unavailable, key: "test" });
    sync.activate(); sync.edit("原标题", 4, 0, "新标题"); expect(await sync.step()).toBe("done");
  });
});
