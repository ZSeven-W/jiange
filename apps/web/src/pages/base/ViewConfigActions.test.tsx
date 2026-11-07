import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ViewConfigActions } from "./ViewConfigActions";

describe("view config actions", () => {
  it("keeps the lock and save controls on a single touch-sized row", () => {
    const html = renderToStaticMarkup(<ViewConfigActions locked dirty saving={false} onLockedChange={() => {}} onClear={() => {}} onSave={() => {}} />);
    expect(html).toContain("flex-nowrap");
    expect(html).toContain("whitespace-nowrap");
    expect(html).toContain("h-8 shrink-0");
    expect(html).toContain("权限视图");
    expect(html).toContain('data-clear-view="true"');
    expect(html).toContain('data-save-view="true"');
  });
});
