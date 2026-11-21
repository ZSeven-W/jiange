import { describe, expect, it } from "vitest";
import { blocksToHtml, parseHtml } from "../src/html.js";

describe("html serialization and parsing", () => {
  it("handles numeric HTML entities, invalid entities, relative/mailto/invalid URLs, and title/todo/code/image fallbacks", () => {
    // Numeric entities (hex & decimal, valid & out-of-range/zero) + br + self-closing inline + invalid closing tag with attrs + single-quoted attrs + no-href link
    const parsed = parseHtml(`
      <p>&#x41;&#66;&#x0;&#0;&#x110000;line1<br/>line2<span/><b>bold</b></span x><a href='https://example.com'>sq</a><a>nohref</a><a href='/rel'>rel</a><a href='#/doc/1'>hash</a><a href='mailto:a@b.com'>mail</a><a href='not a url'>bad</a></p>
      <ul><li><input type="checkbox"/> Unchecked</li><li><input type="checkbox" checked/> Checked</li></ul>
      <pre>plain pre without code</pre>
      <pre><code>no lang code</code></pre>
      <img src='https://example.com/a.png' alt='Single'/>
      <img src="javascript:alert(1)"/>
      <img/>
      <p>&#0;</p>
      <table><tr><td>1</td><td>2</td></tr><tr><td>3</td></tr><tr></tr></table>
      <table><tr></tr></table>
    `);

    expect(parsed[0].text).toBe("ABline1\nline2boldsqnohrefrelhashmailbad");
    expect(parsed[0].spans.some((s) => s.marks.link === "https://example.com")).toBe(true);
    expect(parsed[0].spans.some((s) => s.marks.link === "/rel")).toBe(true);
    expect(parsed[0].spans.some((s) => s.marks.link === "#/doc/1")).toBe(true);
    expect(parsed[0].spans.some((s) => s.marks.link === "mailto:a@b.com")).toBe(true);
    expect(parsed[1]).toMatchObject({ type: "todo", props: { checked: "false" } });
    expect(parsed[2]).toMatchObject({ type: "todo", props: { checked: "true" } });
    expect(parsed[3]).toMatchObject({ type: "code", text: "plain pre without code", props: {} });
    expect(parsed[4]).toMatchObject({ type: "code", text: "no lang code", props: {} });
    expect(parsed[5]).toMatchObject({ type: "image", props: { url: "https://example.com/a.png", name: "Single" } });
    expect(parsed[6]).toMatchObject({ type: "image", props: { name: "image" } });
    expect(parsed[7]).toMatchObject({ type: "image", props: { name: "image" } });
    expect(parsed[8]).toMatchObject({ type: "paragraph", text: "" });
    expect(parsed[9].type).toBe("table");
    expect(JSON.parse(parsed[9].props.tableData)).toEqual([["1", "2"], ["3", ""]]);

    // Empty / whitespace / comment-only HTML returns []
    expect(parseHtml("<!-- comment --><style>body{}</style>   ")).toEqual([]);
  });

  it("serializes title skip, unchecked todo, code without lang/text, image without url/name, and empty/headerless tables", () => {
    const html = blocksToHtml([
      { type: "title", props: {}, spans: [{ text: "Ignored Title", marks: {} }] },
      { type: "todo", props: { checked: "false" }, spans: [{ text: "Open", marks: {} }] },
      { type: "code", props: {}, spans: [{ text: "from spans", marks: {} }] },
      { type: "image", props: {}, spans: [] },
      { type: "image", props: { url: "javascript:evil()", name: "Unsafe" }, spans: [] },
      { type: "table", props: { tableData: '[["a","b"]]', tableHeader: "none" }, spans: [] },
      { type: "table", props: { tableData: "invalid" }, spans: [] },
      { type: "paragraph", props: {}, spans: [{ text: "a", marks: { link: "not valid url" } }] },
    ]);

    expect(html).not.toContain("Ignored Title");
    expect(html).toContain('<input type="checkbox" disabled/> Open');
    expect(html).toContain("<pre><code>from spans</code></pre>");
    expect(html).toContain("<p>[image]</p>");
    expect(html).toContain("<p>[Unsafe]</p>");
    expect(html).toContain("<table><tr><td>a</td><td>b</td></tr></table>");
    expect(html).toContain("<p>a</p>");
  });
});
