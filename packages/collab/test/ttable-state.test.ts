import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Doc, ROOT, encodeOps, toHex } from "../src/index";
import type { Op } from "../src/index";

const writeVector = process.env.TTABLE_WRITE_VECTOR === "1";

/** 表格状态 v2：roundtrip、无表格保持 v1、跨语言向量输出。 */
describe("ttable state", () => {
  it("round-trips payloads and stays deterministic; table-free docs stay v1", () => {
    const d = new Doc(7);
    const b = d.createBlock("paragraph");
    const payload = new TextEncoder().encode(`{"kind":"axis-insert","axis":"row"}`);
    const op: Op = { t: "ttable", id: { client: 7, clock: 9 }, block: b.id, payload };
    d.apply(op);
    expect(d.hasTables()).toBe(true);
    const raw = d.encodeState();
    expect(raw[2]).toBe(2); // StateVersion
    const loaded = Doc.fromState(7, raw);
    expect(loaded.hasTables()).toBe(true);
    expect(loaded.encodeState()).toEqual(raw); // deterministic

    if (writeVector) {
      writeFileSync(resolve(__dirname, "../testdata/ttable-state-vector.json"), JSON.stringify({ hex: toHex(raw), opsHex: toHex(encodeOps([b, op])) }, null, 1) + "\n");
    }

    const plain = new Doc(7);
    const pb = plain.createBlock("paragraph");
    plain.insertText(pb.id, 0, "字");
    expect(plain.encodeState()[2]).toBe(1); // v1 unchanged
  });
});
