import { describe, expect, it } from "vitest";
import { exportableTableMerges, exportableTableWidths } from "../src/docx-tables.js";
import { parseDocxXml } from "../src/docx-xml.js";
import { XmlError } from "../src/xml.js";

describe("docx-tables edge cases", () => {
  it("handles invalid merge payloads and width checks", () => {
    const rows = [["A", ""], ["", "B"]];
    expect(exportableTableMerges(undefined, rows)).toEqual({ merges: [], loss: false });
    expect(exportableTableMerges("{", rows)).toEqual({ merges: [], loss: true });
    expect(exportableTableMerges("{}", rows)).toEqual({ merges: [], loss: true });
    expect(exportableTableMerges("[1, [0,0,1], [0,0,1.5,1], [0,0,1,2]]", rows)).toEqual({
      merges: [[0, 0, 1, 2]],
      loss: true,
    });
    expect(exportableTableWidths(undefined, rows)).toEqual({ twips: null, approximate: false, oversized: false });
  });
});

describe("docx-xml namespace and qualified name validation", () => {
  it("rejects invalid default namespaces, invalid xmlns declarations, bad qnames, and handles unprefixed elements without default xmlns", () => {
    expect(() => parseDocxXml(`<a xmlns="http://www.w3.org/XML/1998/namespace"/>`)).toThrow(XmlError);
    expect(() => parseDocxXml(`<a xmlns="http://www.w3.org/2000/xmlns/"/>`)).toThrow(XmlError);

    expect(() => parseDocxXml(`<a xmlns:="urn:x"/>`)).toThrow(XmlError);
    expect(() => parseDocxXml(`<a xmlns:a:b="urn:x"/>`)).toThrow(XmlError);
    expect(() => parseDocxXml(`<a xmlns:xmlns="urn:x"/>`)).toThrow(XmlError);
    expect(() => parseDocxXml(`<a xmlns:p=""/>`)).toThrow(XmlError);
    expect(() => parseDocxXml(`<a xmlns:p="http://www.w3.org/2000/xmlns/"/>`)).toThrow(XmlError);
    expect(() => parseDocxXml(`<a xmlns:xml="urn:x"/>`)).toThrow(XmlError);
    expect(() => parseDocxXml(`<a xmlns:p="http://www.w3.org/XML/1998/namespace"/>`)).toThrow(XmlError);

    expect(() => parseDocxXml(`<a:b:c/>`)).toThrow(XmlError);
    expect(() => parseDocxXml(`<:a/>`)).toThrow(XmlError);
    expect(() => parseDocxXml(`<a:/>`)).toThrow(XmlError);

    // Unprefixed element with no default namespace in scope
    const unprefixed = parseDocxXml(`<plain attr="1"/>`);
    expect(unprefixed.name).toBe("{}plain");
    expect(unprefixed.attrs.attr).toBe("1");
  });
});
