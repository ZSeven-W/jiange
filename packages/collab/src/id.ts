/** Operation identifier: (client, clock). `clock` is a Lamport timestamp. */
export interface OpId {
  client: number;
  clock: number;
}

/** Virtual root: of the block tree and of every text sequence. */
export const ROOT: OpId = Object.freeze({ client: 0, clock: 0 });

export function idKey(id: OpId): string {
  return `${id.client}:${id.clock}`;
}

export function parseKey(k: string): OpId {
  const [c, k2] = k.split(":");
  return { client: Number(c), clock: Number(k2) };
}

/** Total order used for LWW and sibling ordering: clock first, then client. */
export function cmpId(a: OpId, b: OpId): number {
  if (a.clock !== b.clock) return a.clock < b.clock ? -1 : 1;
  if (a.client !== b.client) return a.client < b.client ? -1 : 1;
  return 0;
}

export function eqId(a: OpId, b: OpId): boolean {
  return a.client === b.client && a.clock === b.clock;
}
