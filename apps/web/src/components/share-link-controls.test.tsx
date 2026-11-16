import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { roleForScope, shareLinkScope, ShareLinkAccessSelect, ShareLinkScopeSelect } from "./share-link-controls";

describe("link sharing scope and access", () => {
  it("preserves edit access only when it was already selected for signed-in users", () => {
    expect(shareLinkScope("none")).toBe("restricted");
    expect(shareLinkScope("anon")).toBe("public");
    expect(shareLinkScope("edit")).toBe("signed-in");
    expect(roleForScope("signed-in", "none")).toBe("view");
    expect(roleForScope("signed-in", "anon")).toBe("view");
    expect(roleForScope("signed-in", "edit")).toBe("edit");
    expect(roleForScope("public", "edit")).toBe("anon");
    expect(roleForScope("restricted", "edit")).toBe("none");
  });
  it("renders separate accessible controls without offering anonymous edit", () => {
    const scope = renderToStaticMarkup(<ShareLinkScopeSelect role="view" allowPublic disabled={false} onChange={() => {}} />);
    const edit = renderToStaticMarkup(<ShareLinkAccessSelect role="view" disabled={false} onChange={() => {}} />);
    const publicAccess = renderToStaticMarkup(<ShareLinkAccessSelect role="anon" disabled={false} onChange={() => {}} />);
    expect(scope).toContain('aria-label="链接分享范围"');
    expect(scope).toContain("互联网上任何人");
    expect(edit).toContain('aria-label="链接分享权限"');
    expect(edit).toContain("可编辑");
    expect(publicAccess).toContain("可阅读");
    expect(publicAccess).not.toContain("可编辑");
    expect(renderToStaticMarkup(<ShareLinkScopeSelect role="view" allowPublic={false} disabled={false} onChange={() => {}} />)).not.toContain("互联网上任何人");
  });
});
