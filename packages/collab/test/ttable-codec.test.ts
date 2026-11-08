import { describe, expect, it } from "vitest";
import { decodeOps, encodeOps } from "../src/index";
import type { Op } from "../src/index";

/** 表格子 CRDT 载荷 op（ttable）双端线格式 roundtrip。 */
describe("ttable codec", () => {
  it("round-trips id/block/payload bytes", () => {
    const op: Op = { t: "ttable", id: { client: 7, clock: 9 }, block: { client: 1, clock: 1 }, payload: Uint8Array.of(1, 2, 3, 250, 0) };
    const back = decodeOps(encodeOps([op]));
    expect(back).toEqual([op]);
  });
});
