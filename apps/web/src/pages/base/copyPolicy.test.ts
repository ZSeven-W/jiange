import { describe, expect, it, vi } from "vitest";
import { blocksBaseCopy, guardBaseClipboard } from "./copyPolicy";

describe("base copy policy", () => {
  it("blocks non-manager copy for protected data and while policy is being refreshed", () => {
    expect(blocksBaseCopy({ role: "view", copyProtected: true }, false)).toBe(true);
    expect(blocksBaseCopy({ role: "edit", copyProtected: true }, false)).toBe(true);
    expect(blocksBaseCopy({ role: "manage", copyProtected: true }, false)).toBe(false);
    expect(blocksBaseCopy({ role: "edit", copyProtected: false }, false)).toBe(false);
    expect(blocksBaseCopy({ role: "manage", copyProtected: false }, true)).toBe(true);
  });
  it("prevents native clipboard events only while blocked", () => {
    const preventDefault = vi.fn();
    guardBaseClipboard({ preventDefault }, false);
    expect(preventDefault).not.toHaveBeenCalled();
    guardBaseClipboard({ preventDefault }, true);
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});
