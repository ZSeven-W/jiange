import { createZip } from "@zseven-w/ooxml/zip";
import { describe, expect, it } from "vitest";
import type { SheetWorksheet } from "../src/types.js";
import {
  exportWorkbookToXlsx,
  importXlsxToWorkbookData,
  numFmtFromCode,
  parseXlsxBytesForWorkbook,
  sheetStyleToXlsx,
  xlsxStyleToSheet,
} from "../src/workbook-xlsx.js";
import {
  resolveXlsxLimits,
  writeXlsx,
  writeXlsxAsync,
  XlsxError,
  type XlsxWorkbook,
} from "../src/xlsx.js";
import { readXlsx } from "../src/xlsx-read.js";
import {
  normalizeXlsxStyle,
  parseMergeRef,
  readXlsxDxfs,
  readXlsxStyles,
  XlsxStyleTable,
} from "../src/xlsx-style.js";
import { xlsxXml } from "../src/xlsx-xml.js";

const enc = new TextEncoder();
const SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";

function makeMinimalZip(overrides: Record<string, string | null> = {}): Uint8Array {
  const base: Record<string, string> = {
    "[Content_Types].xml":
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="${CT_NS}">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
      `</Types>`,
    "_rels/.rels":
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG_REL_NS}">` +
      `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`,
    "xl/workbook.xml":
      `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}">` +
      `<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels":
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG_REL_NS}">` +
      `<Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/>` +
      `</Relationships>`,
    "xl/worksheets/sheet1.xml":
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${SHEET_NS}"><sheetData/></worksheet>`,
  };
  const merged = new Map<string, string>(Object.entries(base));
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) merged.delete(k);
    else merged.set(k, v);
  }
  return createZip([...merged.entries()].map(([name, body]) => ({ name, data: enc.encode(body) })));
}

describe("xlsx-style 100% branch coverage", () => {
  it("covers normalizeXlsxStyle, XlsxStyleTable, and parseMergeRef validation and branches", () => {
    expect(normalizeXlsxStyle({ bold: false })).toBeUndefined();
    expect(() => normalizeXlsxStyle({ bold: "yes" })).toThrow("bold must be a boolean");
    expect(() => normalizeXlsxStyle({ fontName: "bad\u0001" })).toThrow("invalid font name");
    expect(() => normalizeXlsxStyle([])).toThrow("cell style must be an object");
    expect(() => normalizeXlsxStyle(null)).toThrow("cell style must be an object");
    expect(() => normalizeXlsxStyle({ fontSize: 0 })).toThrow("font size must be 1 to 409");
    expect(() => normalizeXlsxStyle({ fontSize: 500 })).toThrow("font size must be 1 to 409");
    expect(() => normalizeXlsxStyle({ horizontal: "justify" })).toThrow("invalid horizontal alignment");
    expect(normalizeXlsxStyle({ horizontal: "left" })?.horizontal).toBe("left");
    expect(normalizeXlsxStyle({ horizontal: "center" })?.horizontal).toBe("center");
    expect(normalizeXlsxStyle({ horizontal: "right" })?.horizontal).toBe("right");
    expect(() => normalizeXlsxStyle({ vertical: "middle" })).toThrow("invalid vertical alignment");
    expect(normalizeXlsxStyle({ vertical: "top" })?.vertical).toBe("top");
    expect(normalizeXlsxStyle({ vertical: "center" })?.vertical).toBe("center");
    expect(normalizeXlsxStyle({ vertical: "bottom" })?.vertical).toBe("bottom");
    expect(() => normalizeXlsxStyle({ border: null })).toThrow("invalid border");
    expect(() => normalizeXlsxStyle({ border: { foo: true } })).toThrow("invalid border");
    expect(normalizeXlsxStyle({ border: { color: "#112233" } })).toBeUndefined();
    expect(normalizeXlsxStyle({ border: { right: true } })?.border).toEqual({ right: true });
    expect(normalizeXlsxStyle({ border: { bottom: true } })?.border).toEqual({ bottom: true });
    expect(normalizeXlsxStyle({ border: { left: true } })?.border).toEqual({ left: true });

    const table = new XlsxStyleTable();
    table.index({ border: { left: true } }); // auto color border + no custom numFmts
    const xml = table.xml(SHEET_NS);
    expect(xml).toContain('color auto="1"');
    expect(xml).not.toContain("<numFmts");

    const dummyAddr = (v: string) => ({ row: v === "A1" ? 0 : 1, col: 0 });
    expect(() => parseMergeRef("A1", dummyAddr)).toThrow("invalid merge range");
    expect(() => parseMergeRef("A1:A1", dummyAddr)).toThrow("invalid merge range");
  });

  it("covers readXlsxStyles errors, colors, fills, borders, numFmts, alignment, and catch", () => {
    expect(() => readXlsxStyles(xlsxXml(`<wrong xmlns="${SHEET_NS}"/>`), new Set())).toThrow(
      "invalid styles part",
    );
    expect(() =>
      readXlsxStyles(
        xlsxXml(`<styleSheet xmlns="${SHEET_NS}"><numFmts><numFmt numFmtId="bad" formatCode="0"/></numFmts></styleSheet>`),
        new Set(),
      ),
    ).toThrow("invalid number format");
    expect(() =>
      readXlsxStyles(
        xlsxXml(`<styleSheet xmlns="${SHEET_NS}"><cellXfs><xf fontId="99"/></cellXfs></styleSheet>`),
        new Set(),
      ),
    ).toThrow("invalid style reference");

    // Empty styleSheet (missing sublists)
    expect(readXlsxStyles(xlsxXml(`<styleSheet xmlns="${SHEET_NS}"/>`), new Set())).toEqual([]);

    // Comprehensive styleSheet covering 6-hex rgb, invalid rgb, auto/indexed=64, theme, indexed=2,
    // gradient fill, non-solid fill, medium border, omitted xf attrs, missing numFmtId,
    // alignment left/center/right/general/justify/extra-attr, and catch on invalid fontName
    const warn = new Set<string>();
    const styles = readXlsxStyles(
      xlsxXml(
        `<styleSheet xmlns="${SHEET_NS}">` +
          `<numFmts><numFmt numFmtId="200" formatCode="0.000"/><numFmt numFmtId="201" formatCode="bad\u0001"/></numFmts>` +
          `<fonts>` +
          `<font><sz val="11"/><name val="Calibri"/><color auto="1"/></font>` +
          `<font><b/><color theme="1"/></font>` +
          `<font><color rgb="112233"/></font>` +
          `<font><color indexed="64"/></font>` +
          `<font><color indexed="2"/></font>` +
          `<font><color rgb="ZZZ"/></font>` +
          `</fonts>` +
          `<fills>` +
          `<fill><patternFill patternType="none"/></fill>` +
          `<fill><gradientFill/></fill>` +
          `<fill><patternFill patternType="lightGray"><fgColor rgb="FF112233"/></patternFill></fill>` +
          `</fills>` +
          `<borders>` +
          `<border><left/><right/><top/><bottom/></border>` +
          `<border><left style="medium"><color indexed="2"/></left></border>` +
          `</borders>` +
          `<cellXfs>` +
          `<xf/>` +
          `<xf fontId="1" fillId="1" borderId="1" numFmtId="999"><alignment horizontal="left" vertical="top"/></xf>` +
          `<xf fontId="2" fillId="2" borderId="0" numFmtId="200"><alignment horizontal="center" vertical="center" indent="1"/></xf>` +
          `<xf fontId="3" fillId="0" borderId="0"><alignment horizontal="right" vertical="bottom"/></xf>` +
          `<xf fontId="4" fillId="0" borderId="0"><alignment horizontal="general"/></xf>` +
          `<xf fontId="5" fillId="0" borderId="0"><alignment horizontal="justify"/></xf>` +
          `<xf fontId="0" fillId="0" borderId="0" numFmtId="201"/>` +
          `</cellXfs>` +
          `</styleSheet>`,
      ),
      warn,
    );
    expect(styles.length).toBe(7);
    expect(styles[2]?.color).toBe("#112233");
    expect(styles[6]).toBeUndefined(); // caught normalizeXlsxStyle failure on numFmtId=201
    expect(warn.has("style_colors_not_preserved")).toBe(true);
    expect(warn.has("cell_formatting_not_preserved")).toBe(true);

    // readXlsxDxfs coverage: missing dxfs, empty dxf, font with/without bold/color, fill with gradient/bgColor/fgColor/themed
    expect(readXlsxDxfs(xlsxXml(`<styleSheet xmlns="${SHEET_NS}"/>`), new Set())).toEqual([]);
    const dxfWarn = new Set<string>();
    const dxfs = readXlsxDxfs(
      xlsxXml(
        `<styleSheet xmlns="${SHEET_NS}"><dxfs>` +
          `<dxf/>` +
          `<dxf><font><b val="0"/><color theme="2"/></font><fill><gradientFill/></fill></dxf>` +
          `<dxf><font><b/><color rgb="FF112233"/></font><fill><patternFill patternType="solid"><bgColor rgb="FFAABBCC"/></patternFill></fill></dxf>` +
          `<dxf><fill><patternFill patternType="solid"><fgColor rgb="FF445566"/></patternFill></fill></dxf>` +
          `<dxf><fill><patternFill patternType="none"/></fill></dxf>` +
          `</dxfs></styleSheet>`,
      ),
      dxfWarn,
    );
    expect(dxfs).toEqual([{}, {}, { bold: true, color: "#112233", bg: "#AABBCC" }, { bg: "#445566" }, {}]);
    expect(dxfWarn.has("style_colors_not_preserved")).toBe(true);
  });
});

describe("xlsx writer 100% branch coverage", () => {
  it("covers resolveXlsxLimits, object/text/cell/extras/definedNames/size limits", async () => {
    expect(resolveXlsxLimits({ maxSheets: 2, maxCells: 10, maxXmlBytes: 1000, maxFileBytes: 2000 })).toEqual({
      maxSheets: 2,
      maxCells: 10,
      maxXmlBytes: 1000,
      maxFileBytes: 2000,
    });
    expect(() => resolveXlsxLimits({ maxSheets: 0 })).toThrow("invalid XLSX limits");
    expect(() => writeXlsx(null as unknown as XlsxWorkbook)).toThrow("workbook must be an object");
    expect(() => writeXlsx({ sheets: [{ name: "S", cells: [{ row: 0, col: 0, value: "x".repeat(32768) }] }] })).toThrow(
      "cell text is too long",
    );
    expect(() => writeXlsx({ sheets: [{ name: "S", cells: [{ row: 0, col: 0, value: "a\u0001b" }] }] })).toThrow(
      "contains invalid XML characters",
    );
    expect(() => writeXlsx({ sheets: [{ name: "S", cells: [{ row: 0, col: 0, value: "\udc00" }] }] })).toThrow(
      "contains invalid XML characters",
    );
    expect(() => writeXlsx({ sheets: [{ name: "S", cells: [{ row: 0, col: 0, value: "\ud800a" }] }] })).toThrow(
      "contains invalid XML characters",
    );
    expect(() =>
      writeXlsx({
        sheets: [{ name: "S", cells: [{ row: 0, col: 0, style: { bold: true }, value: undefined } as never] }],
      }),
    ).toThrow("cell value must be text");
    expect(() =>
      writeXlsx({ sheets: [{ name: "S", cells: [] }] }, { modified: new Date(Number.NaN) }),
    ).toThrow("invalid modified date");

    // Extras errors
    expect(() =>
      writeXlsx({ sheets: [{ name: "S", cells: [], colWidths: [] as never }] }),
    ).toThrow("invalid colWidths");
    expect(() =>
      writeXlsx({ sheets: [{ name: "S", cells: [], colWidths: { 0: 0 } }] }),
    ).toThrow("invalid column width");
    expect(() =>
      writeXlsx({ sheets: [{ name: "S", cells: [], rowHeights: [] as never }] }),
    ).toThrow("invalid rowHeights");
    expect(() =>
      writeXlsx({ sheets: [{ name: "S", cells: [], rowHeights: { 0: 500 } }] }),
    ).toThrow("invalid row height");
    expect(() =>
      writeXlsx({ sheets: [{ name: "S", cells: [], merges: "bad" as never }] }),
    ).toThrow("invalid merge list");
    expect(() =>
      writeXlsx({ sheets: [{ name: "S", cells: [], merges: [{ top: 0, left: 0, bottom: 2000, right: 600 }] }] }),
    ).toThrow("merge range is too large");
    expect(() =>
      writeXlsx({ sheets: [{ name: "S", cells: [], validations: "bad" as never }] }),
    ).toThrow("invalid validations");
    expect(() =>
      writeXlsx({ sheets: [{ name: "S", cells: [], hyperlinks: "bad" as never }] }),
    ).toThrow("invalid hyperlinks");
    expect(() =>
      writeXlsx({ sheets: [{ name: "S", cells: [], hyperlinks: [{ row: -1, col: 0, target: "https://a.com" }] }] }),
    ).toThrow("invalid hyperlink coordinates");
    expect(() =>
      writeXlsx({ sheets: [{ name: "S", cells: [], hyperlinks: [{ row: 0, col: 0, target: "javascript:alert(1)" }] }] }),
    ).toThrow("unsupported hyperlink URL scheme");
    expect(() =>
      writeXlsx({ sheets: [{ name: "S", cells: [], hyperlinks: [{ row: 0, col: 0, target: "not-a-url" }] }] }),
    ).toThrow("unsupported hyperlink URL scheme");
    expect(() =>
      writeXlsx({ sheets: [{ name: "S", cells: [], conditionalFormats: "bad" as never }] }),
    ).toThrow("invalid conditionalFormats");
    expect(() =>
      writeXlsx({ sheets: [{ name: "S", cells: [], conditionalFormats: [null as never] }] }),
    ).toThrow("invalid conditional format rule");
    expect(() =>
      writeXlsx({
        sheets: [{ name: "S", cells: [], conditionalFormats: [{ id: "c", top: 0, left: 0, bottom: 0, right: 0, op: "bogus" as never }] }],
      }),
    ).toThrow("invalid conditional format rule");
    expect(() =>
      writeXlsx({
        sheets: [{ name: "S", cells: [], conditionalFormats: [{ id: "c", top: 0, left: 0, bottom: 0, right: 0, op: "gt", bg: "red" }] }],
      }),
    ).toThrow("conditional format fill color must be #RRGGBB");
    expect(() =>
      writeXlsx({ sheets: [{ name: "S", cells: [], comments: "bad" as never }] }),
    ).toThrow("invalid comments");
    expect(() =>
      writeXlsx({ sheets: [{ name: "S", cells: [], comments: [{ row: -1, col: 0, text: "x" }] }] }),
    ).toThrow("invalid comment coordinates");
    expect(() =>
      writeXlsx({ sheets: [{ name: "S", cells: [], comments: [{ row: 0, col: 0, text: 123 as never }] }] }),
    ).toThrow("invalid comment text");
    expect(() =>
      writeXlsx({ sheets: [{ name: "S", cells: [], comments: [{ row: 0, col: 0, text: "x", author: 123 as never }] }] }),
    ).toThrow("invalid comment author");
    expect(() =>
      writeXlsx({
        sheets: [{ name: "S", cells: [], comments: [{ row: 0, col: 0, text: "a" }, { row: 0, col: 0, text: "b" }] }],
      }),
    ).toThrow("duplicate comment coordinate");
    // Conditional formats with omitted value1/value2 + empty comments array
    const cfDefaultsBytes = writeXlsx({
      sheets: [{
        name: "S",
        cells: [],
        conditionalFormats: [
          { id: "c1", top: 0, left: 0, bottom: 0, right: 0, op: "contains" },
          { id: "c2", top: 0, left: 0, bottom: 0, right: 0, op: "between" },
        ],
        comments: [],
      }],
    });
    expect((await readXlsx(cfDefaultsBytes)).workbook.sheets[0].conditionalFormats?.length).toBe(2);
    expect(() =>
      writeXlsx({ sheets: [{ name: "S", cells: [] }], definedNames: "bad" as never }),
    ).toThrow("invalid definedNames");
    expect(() =>
      writeXlsx({ sheets: [{ name: "S", cells: [] }], definedNames: [{ name: "1bad", ref: "A1" }] }),
    ).toThrow("invalid defined name");
    expect(() =>
      writeXlsx({ sheets: [{ name: "S", cells: [] }], definedNames: [{ name: "X", ref: "A1", sheetName: "NoSuch" }] }),
    ).toThrow("defined name references unknown sheet");

    // Limits: cell XML bytes, workbook XML bytes, and async file bytes
    expect(() =>
      writeXlsx(
        { sheets: [{ name: "S", cells: [{ row: 0, col: 0, value: "hello world" }] }] },
        { limits: { maxXmlBytes: 10 } },
      ),
    ).toThrow("workbook content exceeds the export limit");
    expect(() =>
      writeXlsx({ sheets: [{ name: "S", cells: [] }] }, { limits: { maxXmlBytes: 100 } }),
    ).toThrow("workbook XML exceeds the export limit");
    await expect(
      writeXlsxAsync({ sheets: [{ name: "S", cells: [] }] }, { limits: { maxFileBytes: 10 } }),
    ).rejects.toThrow("XLSX file exceeds the export limit");

    // Positive branches: frozen variants (0/0, r only, c only, both), rowHeights on empty row,
    // formula cached string/boolean/error/none, validations (number min/max/only-min/only-max/neither, date),
    // hyperlinks (http, https, mailto, with/without tooltip), definedNames (localSheetId + leading '=' + plain)
    const bytes = await writeXlsxAsync({
      sheets: [
        {
          name: "S1",
          frozen: { rows: 0, cols: 0 },
          rowHeights: { 5: 25 },
          cells: [
            { row: 0, col: 0, formula: "=1", value: "str" },
            { row: 0, col: 1, formula: "=TRUE()", value: true },
            { row: 0, col: 2, formula: "=FALSE()", value: false },
            { row: 0, col: 3, formula: "=1/0", value: { error: "#DIV/0!" } },
            { row: 0, col: 4, formula: "=2+2" },
          ],
          validations: [
            { id: "v1", top: 0, bottom: 0, left: 0, right: 0, type: "number", min: "1", max: "10", strict: true },
            { id: "v2", top: 1, bottom: 1, left: 0, right: 0, type: "number", min: "1", strict: false },
            { id: "v3", top: 2, bottom: 2, left: 0, right: 0, type: "number", max: "10", strict: false },
            { id: "v4", top: 3, bottom: 3, left: 0, right: 0, type: "date", strict: false },
          ],
          hyperlinks: [
            { row: 0, col: 0, target: "http://example.com" },
            { row: 1, col: 0, target: "mailto:test@example.com", tooltip: "Mail" },
          ],
        },
        { name: "S2", frozen: { rows: 2, cols: 0 }, cells: [] },
        { name: "S3", frozen: { rows: 0, cols: 2 }, cells: [] },
      ],
      definedNames: [
        { name: "LocalName", ref: "=S1!$A$1", sheetName: "S1" },
        { name: "GlobalName", ref: "S1!$A$2" },
      ],
    });
    const parsed = await readXlsx(bytes);
    expect(parsed.workbook.sheets.length).toBe(3);
    expect(parsed.workbook.definedNames).toEqual([
      { name: "LocalName", ref: "S1!$A$1", sheetName: "S1" },
      { name: "GlobalName", ref: "S1!$A$2" },
    ]);
  });
});

describe("workbook-xlsx 100% branch coverage", () => {
  it("covers numFmtFromCode, style conversion, export, and import preview edge branches", async () => {
    expect(numFmtFromCode(undefined)).toBeUndefined();
    expect(numFmtFromCode('"$"\#,##0')).toBe("currency");
    expect(numFmtFromCode("[$USD]#,##0")).toBe("currency");
    expect(numFmtFromCode('"qty"0.0')).toBe("decimal1");
    expect(numFmtFromCode("#,##0;(#,##0)")).toBe("integer");
    expect(numFmtFromCode("@")).toBeUndefined();

    expect(sheetStyleToXlsx({})).toBeUndefined();
    expect(sheetStyleToXlsx({ valign: "top", numFmt: "0.000", borders: { right: true, color: "invalid" } })).toEqual({
      vertical: "top",
      numFmt: "0.000",
      border: { right: true },
    });
    expect(sheetStyleToXlsx({ valign: "middle", borders: { bottom: true, color: "#112233" } })).toEqual({
      vertical: "center",
      border: { bottom: true, color: "#112233" },
    });
    expect(sheetStyleToXlsx({ borders: { left: true } })).toEqual({ border: { left: true } });

    expect(xlsxStyleToSheet({})).toBeUndefined();
    expect(xlsxStyleToSheet({ vertical: "top" })).toEqual({ valign: "top" });
    expect(xlsxStyleToSheet({ vertical: "center" })).toEqual({ valign: "middle" });

    const ws: SheetWorksheet = {
      id: 1,
      nodeId: 1,
      title: "S1",
      pos: 0,
      frozenRows: 1,
      frozenCols: 0,
      merges: [{ top: 0, left: 0, bottom: 1, right: 1 }],
      hyperlinks: [{ row: 0, col: 0, target: "https://example.com" }],
      conditionalFormats: [
        { id: "cf1", top: 0, left: 0, bottom: 1, right: 1, op: "gt", value1: "5", bg: "#DCFCE7", bold: true },
      ],
      comments: [
        { id: 1, worksheetId: 1, rowId: 1, columnId: 1, authorName: "Alice", body: "First line", resolved: false },
        { id: 2, worksheetId: 1, rowId: 1, columnId: 1, authorName: "Bob", body: "Second line", resolved: false },
        { id: 3, worksheetId: 1, rowId: 2, columnId: 2, authorName: "", body: "No author", resolved: false },
        { id: 4, worksheetId: 1, rowId: 1, columnId: 2, authorName: "Skip", body: "", resolved: false },
        { id: 5, worksheetId: 1, rowId: 999, columnId: 1, authorName: "Orphan", body: "Missing row", resolved: false },
      ],
      filter: {},
      revision: 1,
      rows: [{ id: 1, pos: 0 }, { id: 2, pos: 1 }],
      columns: [{ id: 1, pos: 0 }, { id: 2, pos: 1 }, { id: 3, pos: 2 }],
      cells: [
        { rowId: 1, columnId: 1, raw: "", style: { bold: true }, revision: 1 },
        { rowId: 1, columnId: 2, raw: "", revision: 1 },
        { rowId: 1, columnId: 3, raw: "TRUE", revision: 1 },
        { rowId: 2, columnId: 3, raw: "false", revision: 1 },
      ],
    };
    const exported = exportWorkbookToXlsx([ws]);
    const imported = await importXlsxToWorkbookData(exported);
    expect(imported.sheets[0].merges).toEqual([{ top: 0, left: 0, bottom: 1, right: 1 }]);
    expect(imported.sheets[0].frozenRows).toBe(1);
    expect(imported.sheets[0].hyperlinks?.length).toBe(1);
    expect(imported.sheets[0].conditionalFormats?.length).toBe(1);
    expect(imported.sheets[0].comments).toEqual([
      { row: 0, col: 0, text: "First line\nSecond line", author: "Alice" },
      { row: 1, col: 1, text: "No author" },
    ]);

    // Import limits: maxFileBytes, > 50 sheets, maxCells, > MAX_ROWS/MAX_COLS
    await expect(parseXlsxBytesForWorkbook(exported, { limits: { maxFileBytes: 10 } })).rejects.toThrow("20 MiB");
    const sheets51 = Array.from({ length: 51 }, (_, i) => ({ name: `S${i + 1}`, cells: [] }));
    const bytes51 = writeXlsx({ sheets: sheets51 });
    await expect(parseXlsxBytesForWorkbook(bytes51)).rejects.toThrow("50 个工作表");
    await expect(parseXlsxBytesForWorkbook(exported, { limits: { maxCells: 1 } })).rejects.toThrow(
      "too many worksheet cells",
    );
    const bigRowBytes = writeXlsx({ sheets: [{ name: "Big", cells: [{ row: 5000, col: 0, value: 1 }] }] });
    await expect(parseXlsxBytesForWorkbook(bigRowBytes)).rejects.toThrow("上限");

    // Overlapping merges, out-of-bounds merge, empty string cell without style, and unknown warning label
    const customZip = makeMinimalZip({
      "extra.txt": "extra",
      "xl/worksheets/sheet1.xml":
        `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${SHEET_NS}">` +
        `<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t></t></is></c></row></sheetData>` +
        `<mergeCells count="4">` +
        `<mergeCell ref="A1:B2"/>` +
        `<mergeCell ref="B2:C3"/>` +
        `<mergeCell ref="A1:A105"/>` +
        `<mergeCell ref="D1:E2"/>` +
        `</mergeCells>` +
        `</worksheet>`,
    });
    const preview = await parseXlsxBytesForWorkbook(customZip);
    expect(preview.sheets[0].merges).toEqual([
      { top: 0, left: 0, bottom: 1, right: 1 },
      { top: 0, left: 3, bottom: 1, right: 4 },
    ]);
    expect(preview.warnings).toContain("部分超出范围或重叠的合并单元格未导入");
    expect(preview.warnings).toContain("部分扩展属性未导入");
  });
});

describe("xlsx-read 100% branch coverage", () => {
  it("covers safePath, relationships, ZIP validation, content types, and workbook-level errors", async () => {
    // Bad percent-encoding in target
    await expect(
      readXlsx(
        makeMinimalZip({
          "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="%E0%A4%A"/></Relationships>`,
        }),
      ),
    ).rejects.toThrow("invalid relationship target");

    // Backslash in target
    await expect(
      readXlsx(
        makeMinimalZip({
          "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl\\workbook.xml"/></Relationships>`,
        }),
      ),
    ).rejects.toThrow("invalid relationship target");

    // Empty normalized path Target="/"
    await expect(
      readXlsx(
        makeMinimalZip({
          "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="/"/></Relationships>`,
        }),
      ),
    ).rejects.toThrow("invalid relationship target");

    // Valid ".." pop in relative target (xl/../xl/worksheets/sheet1.xml) + directory entry in zip
    const dirZip = createZip([
      { name: "xl/", data: new Uint8Array(0) },
      {
        name: "[Content_Types].xml",
        data: enc.encode(
          `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="${CT_NS}"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
        ),
      },
      {
        name: "_rels/.rels",
        data: enc.encode(
          `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
        ),
      },
      {
        name: "xl/workbook.xml",
        data: enc.encode(
          `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets><sheet name="S1" sheetId="1" r:id="rId1"/><extra/></sheets></workbook>`,
        ),
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: enc.encode(
          `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG_REL_NS}">` +
            `<Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="../xl/worksheets/sheet1.xml"/>` +
            `<Relationship Id="rId2" Type="${REL_NS}/customXml" Target="custom.xml"/>` +
            `</Relationships>`,
        ),
      },
      {
        name: "xl/worksheets/sheet1.xml",
        data: enc.encode(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${SHEET_NS}"><sheetData/></worksheet>`),
      },
    ]);
    const dirRes = await readXlsx(dirZip);
    expect(dirRes.warnings).toContain("workbook_metadata_not_preserved");
    expect(dirRes.warnings).toContain("workbook_relationships_not_preserved");

    // Invalid rels root, missing rel attrs, invalid TargetMode
    await expect(
      readXlsx(makeMinimalZip({ "_rels/.rels": `<Bad xmlns="${PKG_REL_NS}"/>` })),
    ).rejects.toThrow("invalid relationship part");
    await expect(
      readXlsx(
        makeMinimalZip({
          "_rels/.rels": `<Relationships xmlns="${PKG_REL_NS}"><Relationship/></Relationships>`,
        }),
      ),
    ).rejects.toThrow("invalid or duplicate relationship");
    await expect(
      readXlsx(
        makeMinimalZip({
          "_rels/.rels": `<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml" TargetMode="weird"/></Relationships>`,
        }),
      ),
    ).rejects.toThrow("invalid relationship target mode");

    // ZIP limits: too many entries (> 4096), invalid entry name, missing required part, expanded size limit
    const manyEntries = Array.from({ length: 4097 }, (_, i) => ({ name: `f${i}`, data: new Uint8Array(0) }));
    await expect(readXlsx(createZip(manyEntries))).rejects.toThrow("too many ZIP entries");
    await expect(readXlsx(createZip([{ name: "/leading", data: new Uint8Array(0) }]))).rejects.toThrow(
      "invalid ZIP entry name",
    );
    await expect(readXlsx(makeMinimalZip({ "[Content_Types].xml": null }))).rejects.toThrow(
      "missing required part",
    );
    await expect(readXlsx(makeMinimalZip(), { limits: { maxXmlBytes: 50 } })).rejects.toThrow(
      "XLSX expanded content exceeds the limit",
    );

    // Invalid content types root / missing PartName / invalid workbook root
    await expect(
      readXlsx(makeMinimalZip({ "[Content_Types].xml": `<Bad xmlns="${CT_NS}"/>` })),
    ).rejects.toThrow("invalid content types");
    await expect(
      readXlsx(makeMinimalZip({ "[Content_Types].xml": `<Types xmlns="${CT_NS}"><Override/></Types>` })),
    ).rejects.toThrow("invalid or duplicate content type override");
    await expect(
      readXlsx(makeMinimalZip({ "xl/workbook.xml": `<bad xmlns="${SHEET_NS}"/>` })),
    ).rejects.toThrow("unsupported workbook namespace");

    // Cached part hit + invalid styles rel / styles ns / sharedStrings rel / sharedStrings root / extra children / too many shared strings
    await expect(
      readXlsx(
        makeMinimalZip({
          "xl/_rels/workbook.xml.rels":
            `<Relationships xmlns="${PKG_REL_NS}">` +
            `<Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/>` +
            `<Relationship Id="rId2" Type="${REL_NS}/styles" Target="workbook.xml"/>` +
            `</Relationships>`,
        }),
      ),
    ).rejects.toThrow("invalid styles part");
    await expect(
      readXlsx(
        makeMinimalZip({
          "xl/_rels/workbook.xml.rels":
            `<Relationships xmlns="${PKG_REL_NS}">` +
            `<Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/>` +
            `<Relationship Id="rId2" Type="${REL_NS}/styles" Target="styles.xml" TargetMode="External"/>` +
            `</Relationships>`,
        }),
      ),
    ).rejects.toThrow("invalid styles relationship");
    await expect(
      readXlsx(
        makeMinimalZip({
          "xl/_rels/workbook.xml.rels":
            `<Relationships xmlns="${PKG_REL_NS}">` +
            `<Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/>` +
            `<Relationship Id="rId2" Type="${REL_NS}/styles" Target="styles.xml"/>` +
            `</Relationships>`,
          "xl/styles.xml": `<styleSheet xmlns="urn:wrong"/>`,
        }),
      ),
    ).rejects.toThrow("invalid styles part");
    await expect(
      readXlsx(
        makeMinimalZip({
          "xl/_rels/workbook.xml.rels":
            `<Relationships xmlns="${PKG_REL_NS}">` +
            `<Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/>` +
            `<Relationship Id="rId2" Type="${REL_NS}/sharedStrings" Target="ss.xml" TargetMode="External"/>` +
            `</Relationships>`,
        }),
      ),
    ).rejects.toThrow("invalid shared strings relationship");
    await expect(
      readXlsx(
        makeMinimalZip({
          "xl/_rels/workbook.xml.rels":
            `<Relationships xmlns="${PKG_REL_NS}">` +
            `<Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/>` +
            `<Relationship Id="rId2" Type="${REL_NS}/sharedStrings" Target="ss.xml"/>` +
            `</Relationships>`,
          "xl/ss.xml": `<wrong xmlns="${SHEET_NS}"/>`,
        }),
      ),
    ).rejects.toThrow("invalid shared strings");
    await expect(
      readXlsx(
        makeMinimalZip({
          "xl/_rels/workbook.xml.rels":
            `<Relationships xmlns="${PKG_REL_NS}">` +
            `<Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/>` +
            `<Relationship Id="rId2" Type="${REL_NS}/sharedStrings" Target="ss.xml"/>` +
            `</Relationships>`,
          "xl/ss.xml": `<sst xmlns="${SHEET_NS}"><si><t>a</t></si><si><t>b</t></si></sst>`,
        }),
        { limits: { maxCells: 1 } },
      ),
    ).rejects.toThrow("too many shared strings");

    // Shared strings metadata + rich string errors
    const sstWarn = await readXlsx(
      makeMinimalZip({
        "xl/_rels/workbook.xml.rels":
          `<Relationships xmlns="${PKG_REL_NS}">` +
          `<Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/>` +
          `<Relationship Id="rId2" Type="${REL_NS}/sharedStrings" Target="ss.xml"/>` +
          `</Relationships>`,
        "xl/ss.xml": `<sst xmlns="${SHEET_NS}"><extLst/><si><t>ok</t><phoneticPr/></si></sst>`,
      }),
    );
    expect(sstWarn.warnings).toContain("string_metadata_not_preserved");
    await expect(
      readXlsx(
        makeMinimalZip({
          "xl/_rels/workbook.xml.rels":
            `<Relationships xmlns="${PKG_REL_NS}">` +
            `<Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/>` +
            `<Relationship Id="rId2" Type="${REL_NS}/sharedStrings" Target="ss.xml"/>` +
            `</Relationships>`,
          "xl/ss.xml": `<sst xmlns="${SHEET_NS}"><si><t>a</t><t>b</t></si></sst>`,
        }),
      ),
    ).rejects.toThrow("invalid rich string");
    await expect(
      readXlsx(
        makeMinimalZip({
          "xl/_rels/workbook.xml.rels":
            `<Relationships xmlns="${PKG_REL_NS}">` +
            `<Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/>` +
            `<Relationship Id="rId2" Type="${REL_NS}/sharedStrings" Target="ss.xml"/>` +
            `</Relationships>`,
          "xl/ss.xml": `<sst xmlns="${SHEET_NS}"><si><r/></si></sst>`,
        }),
      ),
    ).rejects.toThrow("invalid rich string run");
    await expect(
      readXlsx(
        makeMinimalZip({
          "xl/_rels/workbook.xml.rels":
            `<Relationships xmlns="${PKG_REL_NS}">` +
            `<Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/>` +
            `<Relationship Id="rId2" Type="${REL_NS}/sharedStrings" Target="ss.xml"/>` +
            `</Relationships>`,
          "xl/ss.xml": `<sst xmlns="${SHEET_NS}"><si><t><nested/></t></si></sst>`,
        }),
      ),
    ).rejects.toThrow("unexpected nested text element");
  });

  it("covers sheet descriptor, pane, cols, merges, validations, hyperlinks, definedNames, and cell errors", async () => {
    // Sheet descriptor validations
    await expect(
      readXlsx(makeMinimalZip({ "xl/workbook.xml": `<workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets/></workbook>` })),
    ).rejects.toThrow("invalid number of worksheets");
    await expect(
      readXlsx(makeMinimalZip({ "xl/workbook.xml": `<workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets><sheet sheetId="1" r:id="rId1"/></sheets></workbook>` })),
    ).rejects.toThrow("invalid sheet name");
    await expect(
      readXlsx(
        makeMinimalZip({
          "xl/workbook.xml": `<workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets><sheet name="A" sheetId="1" r:id="rId1"/><sheet name="a" sheetId="2" r:id="rId2"/></sheets></workbook>`,
        }),
      ),
    ).rejects.toThrow("duplicate sheet name");
    await expect(
      readXlsx(makeMinimalZip({ "xl/workbook.xml": `<workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets><sheet name="A" r:id="rId1"/></sheets></workbook>` })),
    ).rejects.toThrow("invalid or duplicate sheet id");
    await expect(
      readXlsx(makeMinimalZip({ "xl/workbook.xml": `<workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets><sheet name="A" sheetId="1"/></sheets></workbook>` })),
    ).rejects.toThrow("invalid worksheet relationship id");
    await expect(
      readXlsx(makeMinimalZip({ "xl/workbook.xml": `<workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets><sheet name="A" sheetId="1" r:id="rMissing"/></sheets></workbook>` })),
    ).rejects.toThrow("unsupported worksheet relationship");
    await expect(
      readXlsx(
        makeMinimalZip({
          "xl/workbook.xml": `<workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets><sheet name="A" sheetId="1" r:id="rId1"/><sheet name="B" sheetId="2" r:id="rId2"/></sheets></workbook>`,
          "xl/_rels/workbook.xml.rels": `<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
        }),
      ),
    ).rejects.toThrow("duplicate worksheet part");
    await expect(
      readXlsx(makeMinimalZip({ "xl/worksheets/sheet1.xml": `<bad xmlns="${SHEET_NS}"/>` })),
    ).rejects.toThrow("invalid worksheet part");

    // Pane variants (split default -> warning, frozenSplit with ySplit only, frozen with 0/0, frozen with non-numeric split)
    const paneSplit = await readXlsx(
      makeMinimalZip({
        "xl/worksheets/sheet1.xml": `<worksheet xmlns="${SHEET_NS}"><sheetViews><sheetView><pane ySplit="bad"/></sheetView></sheetViews><sheetData/></worksheet>`,
      }),
    );
    expect(paneSplit.warnings).toContain("worksheet_features_not_preserved");

    const paneFrozenSplit = await readXlsx(
      makeMinimalZip({
        "xl/worksheets/sheet1.xml": `<worksheet xmlns="${SHEET_NS}"><sheetViews><sheetView><pane state="frozenSplit" ySplit="2"/></sheetView></sheetViews><cols><col/></cols><sheetData/></worksheet>`,
      }),
    );
    expect(paneFrozenSplit.workbook.sheets[0].frozen).toEqual({ rows: 2, cols: 0 });

    const paneZero = await readXlsx(
      makeMinimalZip({
        "xl/worksheets/sheet1.xml": `<worksheet xmlns="${SHEET_NS}"><sheetViews><sheetView><pane state="frozen" ySplit="0" xSplit="0"/></sheetView></sheetViews><sheetData/></worksheet>`,
      }),
    );
    expect(paneZero.workbook.sheets[0].frozen).toBeUndefined();

    // Merge errors: > 10000 merges and missing ref
    const manyMerges = Array.from({ length: 10001 }, () => '<mergeCell ref="A1:B2"/>').join("");
    await expect(
      readXlsx(
        makeMinimalZip({
          "xl/worksheets/sheet1.xml": `<worksheet xmlns="${SHEET_NS}"><sheetData/><mergeCells>${manyMerges}</mergeCells></worksheet>`,
        }),
      ),
    ).rejects.toThrow("too many merged ranges");
    await expect(
      readXlsx(
        makeMinimalZip({
          "xl/worksheets/sheet1.xml": `<worksheet xmlns="${SHEET_NS}"><sheetData/><mergeCells><mergeCell/></mergeCells></worksheet>`,
        }),
      ),
    ).rejects.toThrow("invalid merge range");

    // Data validations + hyperlinks + definedNames + row/cell metadata warnings + ISO date cell + normal formula attr
    const richSheet = await readXlsx(
      makeMinimalZip({
        "xl/workbook.xml":
          `<workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets><sheet name="S1" sheetId="1" r:id="rId1"/></sheets>` +
          `<definedNames>` +
          `<definedName>A1</definedName>` +
          `<definedName name="_xlnm.Print_Area">S1!$A$1</definedName>` +
          `<definedName name="Scoped" localSheetId="0">S1!$A$1</definedName>` +
          `<definedName name="BadScope" localSheetId="99">S1!$A$1</definedName>` +
          `<definedName name="NonNumScope" localSheetId="x">S1!$A$1</definedName>` +
          `</definedNames></workbook>`,
        "xl/worksheets/sheet1.xml":
          `<worksheet xmlns="${SHEET_NS}" xmlns:r="${REL_NS}">` +
          `<sheetData><extra/>` +
          `<row r="1" thickBot="1"><extraCell/>` +
          `<c r="A1" s="2" cm="1"><extra/><f t="normal" ca="1">1+1</f><v>2</v></c>` +
          `<c r="B1" t="d"><v>2024-03-15</v></c>` +
          `</row></sheetData>` +
          `<dataValidations>` +
          `<dataValidation/>` +
          `<dataValidation type="whole" operator="lessThanOrEqual" sqref="A1 BAD"><formula1>10</formula1></dataValidation>` +
          `<dataValidation type="decimal" operator="lessThan" errorStyle="warning" error="msg" sqref="A2:B2"><formula1>5</formula1></dataValidation>` +
          `<dataValidation type="date" operator="between" sqref="A3"><formula1>2024-01-01</formula1><formula2>2024-12-31</formula2></dataValidation>` +
          `<dataValidation type="decimal" operator="greaterThanOrEqual" sqref="A4"/>` +
          `<dataValidation type="decimal" operator="lessThan" sqref="A5"/>` +
          `<dataValidation type="decimal" operator="between" sqref="A6"/>` +
          `<dataValidation type="custom" sqref="A7"><formula1>A1&gt;0</formula1></dataValidation>` +
          `</dataValidations>` +
          `<hyperlinks>` +
          `<hyperlink/>` +
          `<hyperlink ref="A1" r:id="rMissing"/>` +
          `<hyperlink ref="A1" r:id="rUnsafe"/>` +
          `<hyperlink ref="A1" r:id="rBadUrl"/>` +
          `<hyperlink ref="BAD" r:id="rGood"/>` +
          `<hyperlink ref="C1" r:id="rGood"/>` +
          `<hyperlink ref="D1" r:id="rMail"/>` +
          `</hyperlinks>` +
          `</worksheet>`,
        "xl/worksheets/_rels/sheet1.xml.rels":
          `<Relationships xmlns="${PKG_REL_NS}">` +
          `<Relationship Id="rUnsafe" Type="${REL_NS}/hyperlink" Target="ftp://bad.example" TargetMode="External"/>` +
          `<Relationship Id="rBadUrl" Type="${REL_NS}/hyperlink" Target="not a url" TargetMode="External"/>` +
          `<Relationship Id="rGood" Type="${REL_NS}/hyperlink" Target="http://ok.example" TargetMode="External"/>` +
          `<Relationship Id="rMail" Type="${REL_NS}/hyperlink" Target="mailto:a@b.com" TargetMode="External"/>` +
          `</Relationships>`,
      }),
    );
    expect(richSheet.workbook.sheets[0].cells.find((c) => c.col === 1)?.value).toBe("2024-03-15");
    expect(richSheet.workbook.sheets[0].hyperlinks?.length).toBe(2);
    expect(richSheet.warnings).toContain("worksheet_features_not_preserved");
    expect(richSheet.warnings).toContain("row_formatting_not_preserved");
    expect(richSheet.warnings).toContain("row_metadata_not_preserved");
    expect(richSheet.warnings).toContain("cell_formatting_not_preserved");
    expect(richSheet.warnings).toContain("cell_metadata_not_preserved");
    expect(richSheet.warnings).toContain("formula_metadata_not_preserved");

    // Hyperlinks element with NO worksheet rels file
    const hlNoRels = await readXlsx(
      makeMinimalZip({
        "xl/worksheets/sheet1.xml": `<worksheet xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheetData/><hyperlinks><hyperlink ref="A1" r:id="r1"/></hyperlinks></worksheet>`,
      }),
    );
    expect(hlNoRels.workbook.sheets[0].hyperlinks).toBeUndefined();

    // Conditional formatting edge branches (missing sqref, missing type, missing text on containsText,
    // missing/unsupported operator on cellIs, missing formula1/formula2, unsupported colorScale rule)
    const cfEdges = await readXlsx(
      makeMinimalZip({
        "xl/worksheets/sheet1.xml":
          `<worksheet xmlns="${SHEET_NS}"><sheetData/>` +
          `<conditionalFormatting><cfRule/></conditionalFormatting>` +
          `<conditionalFormatting sqref="A1">` +
          `<cfRule type="colorScale" priority="1"/>` +
          `<cfRule type="containsText" priority="2"/>` +
          `<cfRule type="cellIs" priority="3"/>` +
          `<cfRule type="cellIs" operator="between" priority="4"/>` +
          `<cfRule type="cellIs" operator="greaterThan" priority="5" dxfId="bad"><formula>10</formula></cfRule>` +
          `</conditionalFormatting></worksheet>`,
      }),
    );
    expect(cfEdges.warnings).toContain("worksheet_features_not_preserved");
    expect(cfEdges.workbook.sheets[0].conditionalFormats?.length).toBe(3);

    // Comments edge & error branches
    await expect(
      readXlsx(
        makeMinimalZip({
          "xl/worksheets/_rels/sheet1.xml.rels":
            `<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/comments" Target="https://evil.example/c.xml" TargetMode="External"/></Relationships>`,
        }),
      ),
    ).rejects.toThrow("invalid comments relationship");
    await expect(
      readXlsx(
        makeMinimalZip({
          "xl/worksheets/_rels/sheet1.xml.rels":
            `<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/comments" Target="../comments1.xml"/></Relationships>`,
          "xl/comments1.xml": `<wrong xmlns="${SHEET_NS}"/>`,
        }),
      ),
    ).rejects.toThrow("invalid comments part");
    const manyComments = Array.from({ length: 5001 }, () => '<comment ref="A1"><text><t>x</t></text></comment>').join("");
    await expect(
      readXlsx(
        makeMinimalZip({
          "xl/worksheets/_rels/sheet1.xml.rels":
            `<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/comments" Target="../comments1.xml"/></Relationships>`,
          "xl/comments1.xml": `<comments xmlns="${SHEET_NS}"><commentList>${manyComments}</commentList></comments>`,
        }),
      ),
    ).rejects.toThrow("too many comments");
    await expect(
      readXlsx(
        makeMinimalZip({
          "xl/worksheets/_rels/sheet1.xml.rels":
            `<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/comments" Target="../comments1.xml"/></Relationships>`,
          "xl/comments1.xml": `<comments xmlns="${SHEET_NS}"><commentList><comment/></commentList></comments>`,
        }),
      ),
    ).rejects.toThrow("invalid cell reference");
    await expect(
      readXlsx(
        makeMinimalZip({
          "xl/worksheets/_rels/sheet1.xml.rels":
            `<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/comments" Target="../comments1.xml"/></Relationships>`,
          "xl/comments1.xml": `<comments xmlns="${SHEET_NS}"><commentList><comment ref="A1"/></commentList></comments>`,
        }),
      ),
    ).rejects.toThrow("invalid comment");
    const emptyCommentsPart = await readXlsx(
      makeMinimalZip({
        "xl/worksheets/_rels/sheet1.xml.rels":
          `<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/comments" Target="../comments1.xml"/></Relationships>`,
        "xl/comments1.xml": `<comments xmlns="${SHEET_NS}"/>`,
      }),
    );
    expect(emptyCommentsPart.workbook.sheets[0].comments).toBeUndefined();
    const commentNoAuthor = await readXlsx(
      makeMinimalZip({
        "xl/worksheets/_rels/sheet1.xml.rels":
          `<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/comments" Target="../comments1.xml"/></Relationships>`,
        "xl/comments1.xml": `<comments xmlns="${SHEET_NS}"><commentList><comment ref="B2"><text><t>Hi</t></text></comment></commentList></comments>`,
      }),
    );
    expect(commentNoAuthor.workbook.sheets[0].comments).toEqual([{ row: 1, col: 1, text: "Hi" }]);

    // SheetData and cell error branches
    await expect(
      readXlsx(makeMinimalZip({ "xl/worksheets/sheet1.xml": `<worksheet xmlns="${SHEET_NS}"/>` })),
    ).rejects.toThrow("invalid worksheet data");
    await expect(
      readXlsx(makeMinimalZip({ "xl/worksheets/sheet1.xml": `<worksheet xmlns="${SHEET_NS}"><sheetData><row r="0"/></sheetData></worksheet>` })),
    ).rejects.toThrow("invalid row reference");
    await expect(
      readXlsx(
        makeMinimalZip({
          "xl/worksheets/sheet1.xml": `<worksheet xmlns="${SHEET_NS}"><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row></sheetData></worksheet>`,
        }),
        { limits: { maxCells: 1 } },
      ),
    ).rejects.toThrow("too many worksheet cells");
    await expect(
      readXlsx(makeMinimalZip({ "xl/worksheets/sheet1.xml": `<worksheet xmlns="${SHEET_NS}"><sheetData><row r="1"><c/></row></sheetData></worksheet>` })),
    ).rejects.toThrow("invalid cell reference");
    await expect(
      readXlsx(makeMinimalZip({ "xl/worksheets/sheet1.xml": `<worksheet xmlns="${SHEET_NS}"><sheetData><row r="1"><c r="ZZZ1"/></row></sheetData></worksheet>` })),
    ).rejects.toThrow("cell reference is out of range");
    await expect(
      readXlsx(makeMinimalZip({ "xl/worksheets/sheet1.xml": `<worksheet xmlns="${SHEET_NS}"><sheetData><row r="1"><c r="A1"/><c r="A1"/></row></sheetData></worksheet>` })),
    ).rejects.toThrow("duplicate cell reference");
    await expect(
      readXlsx(makeMinimalZip({ "xl/worksheets/sheet1.xml": `<worksheet xmlns="${SHEET_NS}"><sheetData><row r="1"><c r="A1" s="bad"/></row></sheetData></worksheet>` })),
    ).rejects.toThrow("invalid cell style index");
    await expect(
      readXlsx(
        makeMinimalZip({
          "xl/_rels/workbook.xml.rels": `<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`,
          "xl/styles.xml": `<styleSheet xmlns="${SHEET_NS}"><cellXfs><xf/></cellXfs></styleSheet>`,
          "xl/worksheets/sheet1.xml": `<worksheet xmlns="${SHEET_NS}"><sheetData><row r="1"><c r="A1" s="5"/></row></sheetData></worksheet>`,
        }),
      ),
    ).rejects.toThrow("invalid cell style index");
    await expect(
      readXlsx(makeMinimalZip({ "xl/worksheets/sheet1.xml": `<worksheet xmlns="${SHEET_NS}"><sheetData><row r="1"><c r="A1"><v>1</v><v>2</v></c></row></sheetData></worksheet>` })),
    ).rejects.toThrow("invalid cell content");
    await expect(
      readXlsx(makeMinimalZip({ "xl/worksheets/sheet1.xml": `<worksheet xmlns="${SHEET_NS}"><sheetData><row r="1"><c r="A1"><f t="shared" si="0" ref="A1:A2">=1+1</f></c></row></sheetData></worksheet>` })),
    ).rejects.toThrow("invalid formula");
    await expect(
      readXlsx(makeMinimalZip({ "xl/worksheets/sheet1.xml": `<worksheet xmlns="${SHEET_NS}"><sheetData><row r="1"><c r="A1"><f t="array">1+1</f></c></row></sheetData></worksheet>` })),
    ).rejects.toThrow("shared, array or data-table formulas are not supported");
    await expect(
      readXlsx(makeMinimalZip({ "xl/worksheets/sheet1.xml": `<worksheet xmlns="${SHEET_NS}"><sheetData><row r="1"><c r="A1"><f>=1+1</f></c></row></sheetData></worksheet>` })),
    ).rejects.toThrow("invalid formula");
    await expect(
      readXlsx(makeMinimalZip({ "xl/worksheets/sheet1.xml": `<worksheet xmlns="${SHEET_NS}"><sheetData><row r="1"><c r="A1" t="inlineStr"><v>1</v></c></row></sheetData></worksheet>` })),
    ).rejects.toThrow("invalid inline string");
    await expect(
      readXlsx(makeMinimalZip({ "xl/worksheets/sheet1.xml": `<worksheet xmlns="${SHEET_NS}"><sheetData><row r="1"><c r="A1" t="s"><v>99</v></c></row></sheetData></worksheet>` })),
    ).rejects.toThrow("invalid shared string index");
    await expect(
      readXlsx(makeMinimalZip({ "xl/worksheets/sheet1.xml": `<worksheet xmlns="${SHEET_NS}"><sheetData><row r="1"><c r="A1" t="str"><is><t>a</t></is></c></row></sheetData></worksheet>` })),
    ).rejects.toThrow("invalid string cell");
    await expect(
      readXlsx(makeMinimalZip({ "xl/worksheets/sheet1.xml": `<worksheet xmlns="${SHEET_NS}"><sheetData><row r="1"><c r="A1" t="d"/></row></sheetData></worksheet>` })),
    ).rejects.toThrow("invalid ISO date cell");
    await expect(
      readXlsx(makeMinimalZip({ "xl/worksheets/sheet1.xml": `<worksheet xmlns="${SHEET_NS}"><sheetData><row r="1"><c r="A1" t="b"><v>2</v></c></row></sheetData></worksheet>` })),
    ).rejects.toThrow("invalid boolean cell");
    await expect(
      readXlsx(makeMinimalZip({ "xl/worksheets/sheet1.xml": `<worksheet xmlns="${SHEET_NS}"><sheetData><row r="1"><c r="A1" t="e"><v>#BAD!</v></c></row></sheetData></worksheet>` })),
    ).rejects.toThrow("unsupported error cell");
    await expect(
      readXlsx(makeMinimalZip({ "xl/worksheets/sheet1.xml": `<worksheet xmlns="${SHEET_NS}"><sheetData><row r="1"><c r="A1" t="n"><v>abc</v></c></row></sheetData></worksheet>` })),
    ).rejects.toThrow("invalid numeric cell");
    await expect(
      readXlsx(makeMinimalZip({ "xl/worksheets/sheet1.xml": `<worksheet xmlns="${SHEET_NS}"><sheetData><row r="1"><c r="A1" t="n"><v>1e999</v></c></row></sheetData></worksheet>` })),
    ).rejects.toThrow("numeric cell is out of range");
    await expect(
      readXlsx(makeMinimalZip({ "xl/worksheets/sheet1.xml": `<worksheet xmlns="${SHEET_NS}"><sheetData><row r="1"><c r="A1" t="z"><v>1</v></c></row></sheetData></worksheet>` })),
    ).rejects.toThrow("unsupported cell type: z");
    await expect(
      readXlsx(makeMinimalZip({ "xl/worksheets/sheet1.xml": `<worksheet xmlns="${SHEET_NS}"><sheetData><row r="1"><c r="A1" t="b"/></row></sheetData></worksheet>` })),
    ).rejects.toThrow("missing typed cell value");
    await expect(
      readXlsx(makeMinimalZip({ "xl/worksheets/sheet1.xml": `<worksheet xmlns="${SHEET_NS}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${"x".repeat(32768)}</t></is></c></row></sheetData></worksheet>` })),
    ).rejects.toThrow("cell text is too long");
    await expect(
      readXlsx(makeMinimalZip({ "xl/worksheets/sheet1.xml": `<worksheet xmlns="${SHEET_NS}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a\u0001b</t></is></c></row></sheetData></worksheet>` })),
    ).rejects.toThrow("cell text contains invalid XML characters");
    expect(XlsxError).toBeDefined();
  });
});
