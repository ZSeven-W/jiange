import { describe, expect, it } from "vitest";
import { shouldRetryImage } from "./imageRetry";

describe("image retry after synchronization", () => {
  it("waits for the pending write to be acknowledged and limits retries", () => {
    expect(shouldRetryImage({ version: 4, status: "syncing" }, 4, "syncing", 0)).toBe(false);
    expect(shouldRetryImage({ version: 4, status: "syncing" }, 4, "synced", 0)).toBe(true);
    expect(shouldRetryImage({ version: 4, status: "synced" }, 4, "synced", 1)).toBe(false);
    expect(shouldRetryImage({ version: 4, status: "synced" }, 5, "synced", 1)).toBe(true);
    expect(shouldRetryImage({ version: 4, status: "syncing" }, 5, "synced", 2)).toBe(false);
  });
});
