import { describe, expect, it } from "vitest";
import type { SyncClient } from "@jiange/collab";
import { ApiError } from "@/lib/api";
import { namedVersionPoint } from "./namedVersionSafety";
import { versionSaveError } from "./NamedVersionDialog";
import { versionRequestIdentity } from "./versionRequestIdentity";

type Client = Parameters<typeof namedVersionPoint>[0];
const ready = { doc: {} as SyncClient["doc"], caughtUp: true, status: "synced", unacked: 0, epoch: 1, lastSeq: 42, blocked: null, droppedOnResync: 0 } satisfies Client;

describe("safe named version", () => {
  it("uses only a fully acknowledged current history head", () => {
    expect(namedVersionPoint(ready, true, true)).toEqual({ seq: 42, epoch: 1 });
    for (const patch of [{ caughtUp: false }, { unacked: 1 }, { epoch: null }, { status: "offline" as const }, { blocked: "read_only" }, { droppedOnResync: 1 }, { lastSeq: 0 }, { lastSeq: Number.MAX_SAFE_INTEGER + 1 }]) expect(namedVersionPoint({ ...ready, ...patch }, true, true)).toBeNull();
    expect(namedVersionPoint(ready, false, true)).toBeNull();
    expect(namedVersionPoint(ready, true, false)).toBeNull();
  });
  it("reuses the same request for a retry but not for a changed name", () => {
    let counter = 0;
    const generate = () => String(++counter);
    const first = versionRequestIdentity(null, "初稿", generate);
    expect(versionRequestIdentity(first, "初稿", generate)).toBe(first);
    expect(versionRequestIdentity(first, "评审", generate).id).toBe("2");
    expect(counter).toBe(2);
  });
  it("distinguishes rejected writes from an unknown network result", () => {
    expect(versionSaveError(new ApiError(409, "conflict", "文档已变化"))).toBe("文档已变化");
    expect(versionSaveError(new Error("offline"))).toContain("无法确认保存结果");
  });
});
