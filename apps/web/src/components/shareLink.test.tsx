import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ShareInfo } from "@/lib/api";
import { ShareQRCode, verifiedShareUrl } from "./shareLink";

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
  it("renders an accessible local SVG and rejects empty or oversized values", () => {
    const html = renderToStaticMarkup(<ShareQRCode url="https://example.test/#/s/token" />);
    expect(html).toContain("<svg");
    expect(html).toContain('aria-label="扫描二维码打开分享链接"');
    expect(html).not.toContain("<img");
    expect(renderToStaticMarkup(<ShareQRCode url="" />)).not.toContain("<svg");
    expect(renderToStaticMarkup(<ShareQRCode url={"x".repeat(1001)} />)).toContain("无法生成二维码");
  });
});
