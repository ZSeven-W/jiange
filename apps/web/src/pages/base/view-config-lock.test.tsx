import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ViewConfigActions } from "./view-config-actions";

describe("ViewConfigActions (view config lock vs data permissions vs personal view)", () => {
  it("renders separate configLocked and locked toggles for managers", () => {
    const html = renderToStaticMarkup(
      <ViewConfigActions
        locked={false}
        configLocked={true}
        canManage={true}
        dirty={true}
        saving={false}
        onLockedChange={() => {}}
        onConfigLockedChange={() => {}}
        onClear={() => {}}
        onSave={() => {}}
      />,
    );
    expect(html).toContain("data-config-lock-toggle");
    expect(html).toContain("锁定视图配置");
    expect(html).toContain("data-lock-toggle");
    expect(html).toContain("权限视图");
    expect(html).toContain("data-save-view");
  });

  it("shows read-only config-locked badge for non-manage editors and disables saving view config", () => {
    const html = renderToStaticMarkup(
      <ViewConfigActions
        locked={false}
        configLocked={true}
        canManage={false}
        dirty={true}
        saving={false}
        onLockedChange={() => {}}
        onConfigLockedChange={() => {}}
        onClear={() => {}}
        onSave={() => {}}
      />,
    );
    expect(html).toContain("data-config-locked-badge");
    expect(html).toContain("配置已锁定");
    expect(html).not.toContain("data-save-view");
    expect(html).toContain("恢复默认");
  });

  it("shows personal view badge and hides lock toggles on personal views", () => {
    const html = renderToStaticMarkup(
      <ViewConfigActions
        locked={false}
        configLocked={false}
        isPersonal={true}
        canManage={true}
        dirty={false}
        saving={false}
        onLockedChange={() => {}}
        onConfigLockedChange={() => {}}
        onClear={() => {}}
        onSave={() => {}}
      />,
    );
    expect(html).toContain("data-personal-view-badge");
    expect(html).toContain("个人视图");
    expect(html).not.toContain("data-config-lock-toggle");
    expect(html).not.toContain("data-lock-toggle");
  });
});
