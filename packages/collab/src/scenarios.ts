import { Doc, type DocView } from "./doc";
import { ROOT } from "./id";
import type { Op } from "./ops";
import { randomSession } from "./random";

export interface Scenario {
  name: string;
  ops: Op[];
  expected: DocView;
}

function merge(name: string, docs: Doc[], ops: Op[]): Scenario {
  for (const d of docs) for (const op of ops) d.apply(op);
  return { name, ops, expected: docs[0].view() };
}

/** Hand-written and randomized scenarios shared with the Go implementation. */
export function buildScenarios(): Scenario[] {
  const out: Scenario[] = [];

  {
    const a = new Doc(1);
    const ops: Op[] = [];
    const p = a.createBlock("paragraph");
    ops.push(p, a.insertText(p.id, 0, "Hello 飞书 🙂")!, a.format(p.id, 0, 5, "bold", "true")!);
    out.push(merge("single-writer-basic", [new Doc(9)], ops));
  }

  {
    // concurrent inserts at the same position must not interleave
    const a = new Doc(1), b = new Doc(2);
    const p = a.createBlock("paragraph");
    const base = a.insertText(p.id, 0, "[]")!;
    b.apply(p); b.apply(base);
    const x = a.insertText(p.id, 1, "alice")!;
    const y = b.insertText(p.id, 1, "bob")!;
    out.push(merge("concurrent-same-position", [a, b], [p, base, x, y]));
  }

  {
    // concurrent delete + insert inside deleted range, plus overlapping marks
    const a = new Doc(1), b = new Doc(2);
    const p = a.createBlock("paragraph");
    const t = a.insertText(p.id, 0, "abcdef")!;
    b.apply(p); b.apply(t);
    const d1 = a.deleteText(p.id, 1, 3);
    const i1 = b.insertText(p.id, 3, "XY")!;
    const m1 = b.format(p.id, 0, 6, "bold", "true")!;
    const m2 = a.format(p.id, 0, 2, "italic", "true")!;
    const m3 = a.format(p.id, 0, 1, "bold", null)!;
    out.push(merge("delete-insert-marks", [a, b], [p, t, ...d1, i1, m1, m2, m3]));
  }

  {
    // concurrent moves forming a cycle; concurrent prop writes (LWW)
    const a = new Doc(1), b = new Doc(2);
    const x = a.createBlock("paragraph");
    const y = a.createBlock("paragraph");
    b.apply(x); b.apply(y);
    const m1 = a.moveBlock(x.id, y.id);
    const m2 = b.moveBlock(y.id, x.id);
    const s1 = a.setProp(x.id, "color", "red");
    const s2 = b.setProp(x.id, "color", "blue");
    out.push(merge("move-cycle-lww", [a, b], [x, y, m1, m2, s1, s2]));
  }

  {
    // delete parent hides subtree; nested children ordering
    const a = new Doc(1);
    const h = a.createBlock("heading");
    const c1 = a.createBlock("todo", h.id);
    const c2 = a.createBlock("todo", h.id, 0);
    const t = a.insertText(c1.id, 0, "child")!;
    const h2 = a.createBlock("paragraph", ROOT, 0);
    const del = a.deleteBlock(h.id);
    out.push(merge("nested-and-delete", [new Doc(5)], [h, c1, c2, t, h2, del]));
  }

  for (const seed of [1, 2, 3, 42, 2026]) {
    const { ops } = randomSession(seed, 3, 250);
    const fresh = new Doc(99);
    for (const op of ops) fresh.apply(op);
    out.push({ name: `random-${seed}`, ops, expected: fresh.view() });
  }
  return out;
}
