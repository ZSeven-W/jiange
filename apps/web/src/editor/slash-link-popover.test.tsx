import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SlashLinkPopover } from "./slash-link-popover";

describe("slash link editor", () => {
  it("offers labelled text and address fields and starts with confirmation disabled", () => {
    const html = renderToStaticMarkup(<SlashLinkPopover x={20} y={30} onConfirm={() => {}} onCancel={() => {}}/>);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="链接文本"');
    expect(html).toContain('aria-label="链接地址"');
    expect(html).toContain('disabled=""');
  });
});
