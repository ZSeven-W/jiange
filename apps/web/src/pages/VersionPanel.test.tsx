import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "@/lib/api";

vi.mock("./ReadOnlyDoc", () => ({ ReadOnlyDoc: () => null }));
import { RestoreErrorNotice, restoreErrorMessage } from "./VersionPanel";

describe("version restore errors", () => {
  it("preserves actionable server conflict details and explains network failures", () => {
    expect(restoreErrorMessage(new ApiError(409, "stale", "文档已变化，请重新查看版本"))).toBe("文档已变化，请重新查看版本");
    expect(restoreErrorMessage(new ApiError(409, "stale", "Conflict"))).toContain("重新查看");
    expect(restoreErrorMessage(new TypeError("Failed to fetch"))).toContain("网络");
  });

  it("offers a retry only to users who can still edit, while retaining dismissal", () => {
    const action = () => {};
    const html = renderToStaticMarkup(<RestoreErrorNotice error={new ApiError(409, "stale", "文档已变化")} canEdit onRetry={action} onDismiss={action} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("重新尝试");
    expect(html).toContain("关闭提示");
    const readonly = renderToStaticMarkup(<RestoreErrorNotice error={new Error("offline")} canEdit={false} onRetry={action} onDismiss={action} />);
    expect(readonly).not.toContain("重新尝试");
    expect(readonly).toContain("关闭提示");
  });
});
