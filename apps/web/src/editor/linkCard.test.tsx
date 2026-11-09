import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LinkCard, linkDisplay } from "./LinkCard";

const noop = () => {};

describe("link hover card", () => {
  it("splits a URL into host and the rest", () => {
    expect(linkDisplay("https://www.feishu.cn/")).toEqual({ host: "www.feishu.cn", rest: "" });
    expect(linkDisplay("https://a.dev/docs/x?y=1#z")).toEqual({ host: "a.dev", rest: "/docs/x?y=1#z" });
    expect(linkDisplay("not a url")).toEqual({ host: "not a url", rest: "" });
  });
  it("offers open, copy, edit and unlink to editors", () => {
    const html = renderToStaticMarkup(<LinkCard href="https://a.dev/x" x={0} y={0} onOpen={noop} onCopy={noop} onEdit={noop} onUnlink={noop} />);
    for (const attr of ["data-link-card-url", "data-link-open", "data-link-copy", "data-link-edit", "data-link-unlink"]) expect(html).toContain(attr);
    expect(html).toContain('rel="noopener noreferrer"');
  });
  it("is open/copy only for readers and shows the edit field when editing", () => {
    const ro = renderToStaticMarkup(<LinkCard href="https://a.dev" x={0} y={0} onOpen={noop} onCopy={noop} />);
    expect(ro).not.toContain("data-link-edit");
    expect(ro).not.toContain("data-link-unlink");
    const ed = renderToStaticMarkup(<LinkCard href="https://a.dev" x={0} y={0} onOpen={noop} onCopy={noop} onEdit={noop} initialEditing />);
    expect(ed).toContain("data-link-card-input");
    expect(ed).toContain('value="https://a.dev"');
  });
});

describe("document mention card", () => {
  it("shows the document title instead of a URL and has no edit button", () => {
    const html = renderToStaticMarkup(<LinkCard href="#/doc/1" docTitle="产品需求文档" x={0} y={0} onOpen={noop} onCopy={noop} onEdit={noop} onUnlink={noop} />);
    expect(html).toContain("data-link-card-doc");
    expect(html).toContain("产品需求文档");
    expect(html).toContain("云文档");
    expect(html).toContain('title="打开文档"');
    expect(html).not.toContain("data-link-edit");
    expect(html).not.toContain("data-link-card-url");
  });
});
