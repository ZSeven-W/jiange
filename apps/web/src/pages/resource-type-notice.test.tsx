import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResourceTypeNotice } from "./resource-type-notice";

describe("resource type notice", () => {
  it("only links to a verified known type", () => {
    expect(renderToStaticMarkup(<ResourceTypeNotice id={7} kind="base" verified />)).toContain('href="#/base/7"');
    expect(renderToStaticMarkup(<ResourceTypeNotice id={7} kind="base" />)).not.toContain('href="#/base/7"');
    const sheetNotice = renderToStaticMarkup(<ResourceTypeNotice id={7} kind="sheet" verified />);
    expect(sheetNotice).toContain('href="#/sheet/7"');
    expect(sheetNotice).not.toContain('href="#/doc/7"');
    const unknownNotice = renderToStaticMarkup(<ResourceTypeNotice id={7} kind="unknown-kind" verified />);
    expect(unknownNotice).not.toContain('href="#/doc/7"');
    expect(unknownNotice).not.toContain("打开对应文件");
    expect(unknownNotice).toContain('href="#/"');
  });

  it("does not offer navigation while a slide draft is unsaved", () => {
    const html = renderToStaticMarkup(<ResourceTypeNotice id={7} kind="base" verified blockNavigation>未保存内容</ResourceTypeNotice>);
    expect(html).toContain("未保存内容");
    expect(html).not.toContain("href=");
  });
});
