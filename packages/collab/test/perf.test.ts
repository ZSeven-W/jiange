import { describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { Tx } from "../src/tx";

/**
 * P6 performance gate: typing into a long (50k-char) document must stay
 * within the 16ms-per-keystroke input budget on average. Generous slack for
 * CI noise; a real regression (e.g. an O(n²) apply) blows far past it.
 */
describe("typing latency on a 50k-char document", () => {
  it("applies 100 single-char inserts in well under 16ms each", () => {
    const doc = new Doc(101);
    const para = doc.createBlock("paragraph").id;
    const chunk = "剑".repeat(1000);
    let at = 0;
    for (let i = 0; i < 50; i++) {
      doc.insertText(para, at, chunk);
      at += 1000;
    }
    expect(doc.text(para).length).toBe(50000);

    const tx = new Tx(doc);
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) tx.insert(para, 25000 + i, "字");
    const perOp = (performance.now() - t0) / 100;
    expect(perOp).toBeLessThan(16);
    expect(doc.text(para).length).toBe(50100);
  });

  it("integrating a 50-op remote batch into a long doc stays cheap", () => {
    const doc = new Doc(102);
    const para = doc.createBlock("paragraph").id;
    doc.insertText(para, 0, "剑".repeat(50000));
    const ids = doc.visibleIds(para);
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) {
      // ops authored by a peer, applied locally as they arrive off the wire
      doc.apply({ t: "tins", id: { client: 77, clock: 1000 + i }, block: para, parent: ids[i * 3], side: 1, text: "远" });
    }
    const perOp = (performance.now() - t0) / 50;
    expect(perOp).toBeLessThan(16);
    expect(doc.text(para).length).toBe(50050);
  });
});
