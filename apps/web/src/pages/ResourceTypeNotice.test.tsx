import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResourceTypeNotice } from "./ResourceTypeNotice";

describe("resource type notice", () => {
  it("only links to a verified known type", () => {
    expect(renderToStaticMarkup(<ResourceTypeNotice id={7} kind="base" verified />)).toContain('href="#/base/7"');
    expect(renderToStaticMarkup(<ResourceTypeNotice id={7} kind="base" />)).not.toContain('href="#/base/7"');
    expect(renderToStaticMarkup(<ResourceTypeNotice id={7} kind="sheet" verified />)).not.toContain('href="#/doc/7"');
  });

  it("does not offer navigation while a slide draft is unsaved", () => {
    const html = renderToStaticMarkup(<ResourceTypeNotice id={7} kind="base" verified blockNavigation>未保存内容</ResourceTypeNotice>);
    expect(html).toContain("未保存内容");
    expect(html).not.toContain("href=");
  });
});
