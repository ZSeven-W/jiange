import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ShareInfo } from "@/lib/api";
import { ShareQRCode, verifiedDirectShareUrl, verifiedShareUrl } from "./shareLink";

const share: ShareInfo = { role: "manage", members: [], link: { role: "view", token: "test-token" } };

describe("share QR", () => {
  it("never exposes a disabled, missing, or unverified link", () => {
    expect(verifiedShareUrl(share, "https://example.test", false)).toBe("");
    expect(verifiedShareUrl(undefined, "https://example.test", true)).toBe("");
    expect(verifiedShareUrl({ ...share, link: { role: "none", token: "old" } }, "https://example.test", true)).toBe("");
    expect(verifiedShareUrl({ ...share, link: { role: "view" } }, "https://example.test", true)).toBe("");
  });
  it("uses the correct route and escapes tokens", () => {
    expect(verifiedShareUrl(share, "https://example.test", true)).toBe("https://example.test/#/s/test-token");
    expect(verifiedShareUrl({ ...share, link: { role: "anon", token: "a/b" } }, "https://example.test", true)).toBe("https://example.test/#/p/a%2Fb");
  });
  it("uses a permission-checked direct address when link sharing is closed", () => {
    const closed: ShareInfo = { ...share, link: { role: "none", token: "old-disabled-token" } };
    expect(verifiedDirectShareUrl(closed, { id: 42, kind: "doc" }, "https://example.test", "/workspace/", true)).toBe("https://example.test/workspace/#/doc/42");
    expect(verifiedDirectShareUrl(closed, { id: 42, kind: "base" }, "https://example.test", "/", true)).toBe("https://example.test/#/base/42");
    expect(verifiedDirectShareUrl(closed, { id: 42, kind: "slides" }, "https://example.test", "/", true)).toBe("https://example.test/#/slides/42");
    expect(verifiedDirectShareUrl(closed, { id: 42, kind: "file" }, "https://example.test", "/", true)).toBe("https://example.test/#/file/42");
    expect(verifiedDirectShareUrl(closed, { id: 42 }, "https://example.test", "/", false)).toBe("");
    expect(verifiedDirectShareUrl(share, { id: 42 }, "https://example.test", "/", true)).toBe("");
    expect(verifiedDirectShareUrl(closed, { id: 0 }, "https://example.test", "/", true)).toBe("");
    expect(verifiedDirectShareUrl(closed, { id: 42 }, "https://example.test", "//other.test/", true)).toBe("");
  });
  it("renders an accessible local SVG and rejects empty or oversized values", () => {
    const html = renderToStaticMarkup(<ShareQRCode url="https://example.test/#/s/token" />);
    expect(html).toContain("<svg");
    expect(html).toContain('aria-label="扫描二维码打开分享链接"');
    expect(html).not.toContain("<img");
    expect(renderToStaticMarkup(<ShareQRCode url="" />)).not.toContain("<svg");
    expect(renderToStaticMarkup(<ShareQRCode url={"x".repeat(1001)} />)).toContain("无法生成二维码");
  });
});
