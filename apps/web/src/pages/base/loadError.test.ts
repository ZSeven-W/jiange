import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { baseLoadError } from "./loadError";

describe("base access errors", () => {
  it("distinguishes permission or missing documents from temporary failures", () => {
    for (const status of [401, 403, 404]) expect(baseLoadError(new ApiError(status, "error", ""))).toBe("多维表格不存在或无权访问");
    expect(baseLoadError(new TypeError("network failed"))).toBe("暂时无法加载多维表格，请检查网络");
    expect(baseLoadError(new ApiError(503, "error", ""))).toBe("暂时无法加载多维表格，请检查网络");
  });
});
