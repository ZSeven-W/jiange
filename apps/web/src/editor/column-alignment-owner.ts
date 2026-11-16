type LockProvider = Pick<LockManager, "request">;
export interface AlignmentOwnerLease { release(): Promise<void> }

/** Keep one tab responsible for settling a pending undo until it closes or releases ownership. */
export async function acquireAlignmentOwner(locks: LockProvider | undefined, docId: number, userId: number): Promise<AlignmentOwnerLease | null> {
  if (!locks || !Number.isSafeInteger(docId) || docId <= 0 || !Number.isSafeInteger(userId) || userId <= 0) return null;
  const name = `jiange:column-align-owner:v1:${userId}:${docId}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    let done!: () => void;
    const finished = new Promise<void>((resolveFinished) => { done = resolveFinished; });
    void locks.request(name, { ifAvailable: true }, async (lock) => {
      if (!lock) { settled = true; resolve(null); return; }
      let release!: () => void;
      const closed = new Promise<void>((done) => { release = done; });
      let released = false;
      settled = true;
      resolve({ release: () => { if (!released) { released = true; release(); } return finished; } });
      await closed;
    }).then(done, (error) => { done(); if (!settled) reject(error); });
  });
}
