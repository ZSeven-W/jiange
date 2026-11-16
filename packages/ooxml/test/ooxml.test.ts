import { describe, expect, it } from "vitest";
import { createZip, listZip, readZipEntry, parseXml, child, XmlError } from "../src/index.js";

describe("shared OOXML primitives", () => {
  it("reads a bounded XML entry from a generated archive", async () => {
    const bytes = createZip([{ name: "part.xml", data: new TextEncoder().encode("<root><item>内容</item></root>") }]);
    const entries = listZip(bytes);
    const xml = new TextDecoder().decode(await readZipEntry(bytes, entries[0], 1024));
    expect(child(parseXml(xml), "item")?.children).toEqual(["内容"]);
  });
  it("rejects malformed entities and documents over a caller-supplied element limit", () => {
    expect(() => parseXml("<r>A&B</r>")).toThrow(XmlError);
    expect(() => parseXml("<r>&#0;</r>")).toThrow(XmlError);
    expect(() => parseXml("<r><a/><b/></r>", {maxNodes:2})).toThrow(/too many/);
    expect(child(parseXml("<r>A&amp;B</r>"), "x")).toBeUndefined();
  });
});
