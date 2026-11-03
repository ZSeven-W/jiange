import { Doc } from "./doc";
import type { OpId } from "./id";
import type { Op } from "./ops";

/** Small deterministic PRNG (mulberry32) for reproducible property tests. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["a", "b", "c", "飞", "书", "x", "yz", "🙂", " ", "hello"];
const TYPES = ["paragraph", "heading", "todo", "quote"];

/**
 * Simulates `replicas` peers editing concurrently with random partial sync.
 * Returns every op generated (in generation order) and the replicas.
 */
export function randomSession(seed: number, replicas = 3, steps = 200): { ops: Op[]; docs: Doc[] } {
  const r = rng(seed);
  const pick = <T>(a: T[]): T => a[Math.floor(r() * a.length)];
  const docs = Array.from({ length: replicas }, (_, i) => new Doc(i + 1));
  const log: Op[] = [];
  const inbox: Op[][] = docs.map(() => []);
  const emit = (from: number, ops: (Op | null)[]) => {
    for (const op of ops) {
      if (!op) continue;
      log.push(op);
      inbox.forEach((q, i) => i !== from && q.push(op));
    }
  };
  for (let s = 0; s < steps; s++) {
    const i = Math.floor(r() * replicas);
    const d = docs[i];
    // deliver a random subset of inbox, possibly out of order and duplicated
    if (r() < 0.4 && inbox[i].length) {
      const k = Math.floor(r() * inbox[i].length) + 1;
      for (let j = 0; j < k; j++) {
        const idx = Math.floor(r() * inbox[i].length);
        const op = inbox[i][idx];
        d.apply(op);
        if (r() < 0.8) inbox[i].splice(idx, 1);
      }
    }
    const blocks = d.view().blocks.map((b) => {
      const [c, k] = b.id.split(":");
      return { id: { client: +c, clock: +k } as OpId, len: b.spans.reduce((n, sp) => n + [...sp.text].length, 0) };
    });
    const x = r();
    if (blocks.length === 0 || x < 0.08) {
      const parent = blocks.length && r() < 0.3 ? pick(blocks).id : { client: 0, clock: 0 };
      emit(i, [d.createBlock(pick(TYPES), parent, Math.floor(r() * 4))]);
    } else if (x < 0.5) {
      const b = pick(blocks);
      emit(i, [d.insertText(b.id, Math.floor(r() * (b.len + 1)), pick(WORDS))]);
    } else if (x < 0.68) {
      const b = pick(blocks);
      if (b.len) {
        const at = Math.floor(r() * b.len);
        emit(i, d.deleteText(b.id, at, 1 + Math.floor(r() * Math.min(3, b.len - at))));
      }
    } else if (x < 0.8) {
      const b = pick(blocks);
      if (b.len) {
        const from = Math.floor(r() * b.len);
        const to = from + 1 + Math.floor(r() * (b.len - from));
        emit(i, [d.format(b.id, from, to, pick(["bold", "italic", "color"]), r() < 0.25 ? null : pick(["1", "red", "blue"]))]);
      }
    } else if (x < 0.88) {
      const b = pick(blocks);
      emit(i, [d.setProp(b.id, pick(["checked", "level", "color"]), pick(["true", "false", "2", "3"]))]);
    } else if (x < 0.96) {
      const b = pick(blocks);
      const parent = r() < 0.5 ? { client: 0, clock: 0 } : pick(blocks).id;
      emit(i, [d.moveBlock(b.id, parent, Math.floor(r() * 4))]);
    } else if (blocks.length > 2) {
      emit(i, [d.deleteBlock(pick(blocks).id)]);
    }
  }
  // final full delivery
  docs.forEach((d, i) => inbox[i].forEach((op) => d.apply(op)));
  return { ops: log, docs };
}

export function shuffle<T>(a: T[], r: () => number): T[] {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}
