import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { renameErrorMessage } from "./Sidebar";

describe("rename failure messages", () => {
  it("explains permission denial and conflicting changes", () => {
    expect(renameErrorMessage(new ApiError(403, "forbidden", "denied"))).toContain("没有编辑权限");
    expect(renameErrorMessage(new ApiError(409, "conflict", "changed"))).toContain("重新命名");
    expect(renameErrorMessage(new ApiError(409, "upgrade_required", ""))).toContain("刷新页面");
  });

  it("does not claim a network-interrupted mutation failed on the server", () => {
    expect(renameErrorMessage(new TypeError("network"))).toContain("无法确认");
    expect(renameErrorMessage(new ApiError(503, "unavailable", ""))).toContain("无法确认");
  });
});
