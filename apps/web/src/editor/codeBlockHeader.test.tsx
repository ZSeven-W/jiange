import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CODE_LANGS, CodeBlockHeader, codeLangLabel, filterCodeLangs } from "./CodeBlockHeader";

describe("Feishu code block header", () => {
  it("labels languages and falls back to 纯文本", () => {
    expect(codeLangLabel("go")).toBe("Go");
    expect(codeLangLabel(undefined)).toBe("纯文本");
    expect(codeLangLabel("cobol")).toBe("纯文本");
  });
  it("searches by id or display name", () => {
    expect(filterCodeLangs("type").map(([v]) => v)).toEqual(["typescript"]);
    expect(filterCodeLangs("纯").map(([v]) => v)).toEqual(["plain"]);
    expect(filterCodeLangs("  ")).toHaveLength(CODE_LANGS.length);
    expect(filterCodeLangs("zzz")).toEqual([]);
  });
  it("renders the language menu, wrap toggle and copy for editors", () => {
    const html = renderToStaticMarkup(<CodeBlockHeader lang="go" wrap onLang={() => {}} onWrap={() => {}} onCopy={() => {}} initialOpen />);
    expect(html).toContain('data-code-lang="go"');
    expect(html).toContain("data-code-lang-search");
    expect(html.match(/data-code-lang-option=/g)).toHaveLength(CODE_LANGS.length);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-code-wrap/);
    expect(html).toContain("data-code-copy");
  });
  it("shows only the language label to readers without copy permission", () => {
    const html = renderToStaticMarkup(<CodeBlockHeader lang="sql" wrap={false} initialOpen />);
    expect(html).toContain("SQL");
    expect(html).not.toContain("data-code-lang-pop");
    expect(html).not.toContain("data-code-wrap");
    expect(html).not.toContain("data-code-copy");
  });
});
