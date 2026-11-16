import { describe, expect, it } from "vitest";
import { acquireAlignmentOwner } from "./column-alignment-owner";

class LocksMock {
  private held = new Set<string>();
  async request<T>(name: string, _options: unknown, callback: (lock: object | null) => Promise<T>): Promise<T> {
    if (this.held.has(name)) return callback(null);
    this.held.add(name); try { return await callback({}); } finally { this.held.delete(name); }
  }
}
describe("column alignment ownership", () => {
  it("keeps other tabs out until the owner releases, without blocking other accounts", async () => {
    const locks = new LocksMock() as unknown as Pick<LockManager, "request">;
    const first = await acquireAlignmentOwner(locks, 7, 2);
    expect(first).not.toBeNull();
    expect(await acquireAlignmentOwner(locks, 7, 2)).toBeNull();
    const other = await acquireAlignmentOwner(locks, 7, 3);
    expect(other).not.toBeNull(); await other!.release();
    await Promise.all([first!.release(), first!.release()]);
    const recovered = await acquireAlignmentOwner(locks, 7, 2);
    expect(recovered).not.toBeNull(); await recovered!.release();
  });
  it("fails closed when cross-tab locking or a valid scope is unavailable", async () => {
    expect(await acquireAlignmentOwner(undefined, 7, 2)).toBeNull();
    expect(await acquireAlignmentOwner(new LocksMock() as unknown as Pick<LockManager, "request">, 0, 2)).toBeNull();
  });
});
