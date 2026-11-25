import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createZip, listZip, readZipEntry } from "@zseven-w/ooxml/zip";
import { readXlsx, XLSX_MAX_INPUT_BYTES } from "../src/xlsx-read.js";
import { writeXlsx, XlsxError } from "../src/xlsx.js";

const encoder = new TextEncoder(), decoder = new TextDecoder();
async function replacePart(source: Uint8Array, path: string, replace: (xml: string) => string, extra: {name:string;data:Uint8Array}[] = []) {
  const entries = await Promise.all(listZip(source).map(async (entry) => ({name:entry.name,data:await readZipEntry(source,entry,2_000_000)})));
  const item = entries.find((entry) => entry.name === path)!;
  item.data = encoder.encode(replace(decoder.decode(item.data)));
  return createZip([...entries,...extra]);
}

describe("XLSX import", () => {
  it("round-trips cell styles, number formats, merges and frozen panes", async () => {
    const workbook = { sheets: [
      { name:"预算", cells:[
        {row:0,col:0,value:"项目",style:{bold:true,fill:"#EEF3FF",horizontal:"center" as const}},
        {row:1,col:1,value:12000,style:{numFmt:'"¥"#,##0.00',border:{top:true,bottom:true,color:"#9AA0A6"}}},
        {row:1,col:2,value:0.25,style:{numFmt:"0%",italic:true,underline:true,strike:true,color:"#D83931",fontName:"PingFang SC",fontSize:14}},
        {row:2,col:0,formula:"=B2*2",style:{wrap:true,vertical:"top" as const}},
        {row:3,col:3,style:{fill:"#FFF7E6"}},
      ], merges:[{top:4,left:0,bottom:4,right:2}], frozen:{rows:1,cols:1} },
      { name:"无样式", cells:[{row:0,col:0,value:1}], frozen:{rows:2,cols:0} },
    ] };
    const result = await readXlsx(writeXlsx(workbook));
    expect(result.workbook).toEqual(workbook);
    expect(result.warnings).toEqual([]);
  });
  it("round-trips multiple sheets, formulas, cached results and error cells", async () => {
    const workbook = { sheets: [
      { name:"计划", cells:[{row:0,col:0,value:"文本\r\n下一行"},{row:1,col:0,value:8},{row:1,col:1,formula:"=A2*2",value:16},{row:2,col:0,value:true},{row:3,col:0,value:{error:"#DIV/0!" as const}}] },
      { name:"汇总", cells:[{row:0,col:0,formula:"='计划'!B2"}] },
    ] };
    const result = await readXlsx(writeXlsx(workbook));
    expect(result.workbook).toEqual(workbook);
    expect(result.warnings).toEqual([]);
  });
  it("reads a real compressed OpenPyXL file including cell styles", async () => {
    const bytes = await readFile(new URL("./fixtures/openpyxl-basic.xlsx", import.meta.url));
    const result = await readXlsx(bytes);
    expect(result.workbook.sheets.map((sheet) => sheet.name)).toEqual(["计划","汇总"]);
    expect(result.workbook.sheets[0].cells).toContainEqual({row:1,col:3,formula:"=B2*2"});
    expect(result.workbook.sheets[0].cells).toContainEqual({row:1,col:4,value:{error:"#DIV/0!"}});
    expect(result.workbook.sheets[0].cells).toContainEqual({row:0,col:0,value:"项目",style:{bold:true}});
    expect(result.warnings).not.toContain("styles_not_preserved");
    expect(result.warnings).not.toContain("cell_formatting_not_preserved");
  });
  it("reads shared rich strings and reports their formatting loss", async () => {
    const base = writeXlsx({sheets:[{name:"Sheet1",cells:[{row:0,col:0,value:"abc"}]}]});
    const withSheet = await replacePart(base,"xl/worksheets/sheet1.xml",(xml) => xml.replace('<c r="A1" t="inlineStr"><is><t xml:space="preserve">abc</t></is></c>', '<c r="A1" t="s"><v>0</v></c>'));
    const shared = encoder.encode('<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><r><rPr><b/></rPr><t>ab</t></r><r><t>c</t></r></si></sst>');
    const bytes = await replacePart(withSheet,"xl/_rels/workbook.xml.rels",(xml) => xml.replace('</Relationships>','<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>'),[{name:"xl/sharedStrings.xml",data:shared}]);
    const result = await readXlsx(bytes);
    expect(result.workbook.sheets[0].cells).toEqual([{row:0,col:0,value:"abc"}]);
    expect(result.warnings).toContain("rich_text_formatting_not_preserved");
  });
  it("accepts equivalent namespace prefixes, reads merges and warns about unsupported worksheet features", async () => {
    const base = writeXlsx({sheets:[{name:"Sheet1",cells:[{row:0,col:0,value:1}]}]});
    const bytes = await replacePart(base,"xl/worksheets/sheet1.xml",(xml) => xml.replace('xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"','xmlns:ss="http://schemas.openxmlformats.org/spreadsheetml/2006/main"').replace(/<(\/?)(worksheet|sheetData|row|c|v)(?=[\s>])/g,'<$1ss:$2').replace('</ss:worksheet>','<ss:mergeCells><ss:mergeCell ref="A1:B1"/></ss:mergeCells><ss:sheetProtection sheet="1"/></ss:worksheet>'));
    const result = await readXlsx(bytes);
    expect(result.workbook.sheets[0].cells).toEqual([{row:0,col:0,value:1}]);
    expect(result.workbook.sheets[0].merges).toEqual([{top:0,left:0,bottom:0,right:1}]);
    expect(result.warnings).toContain("worksheet_features_not_preserved");
  });

  it("round-trips DEFLATE writeXlsxAsync with sharedStrings, colWidths, rowHeights, validations, hyperlinks, definedNames, and expands shared formulas", async () => {
    const { writeXlsxAsync } = await import("../src/xlsx.js");
    const workbook = {
      definedNames: [{ name: "TaxRate", ref: "Sheet1!$B$1" }],
      sheets: [{
        name: "Sheet1",
        colWidths: { 0: 24, 1: 14.5 },
        rowHeights: { 0: 28 },
        validations: [
          { id: "dv-1", top: 1, left: 0, bottom: 5, right: 0, type: "list" as const, options: ["Open", "Done"], strict: true, hint: "Choose status" },
          { id: "dv-2", top: 1, left: 1, bottom: 5, right: 1, type: "number" as const, min: "0", max: "100", strict: false },
        ],
        hyperlinks: [{ row: 0, col: 0, target: "https://jiange.dev", tooltip: "Home" }],
        cells: Array.from({ length: 40 }, (_, r) => ({ row: r, col: 0, value: r === 0 ? "Status" : "Repeated Label Text" })),
      }],
    };
    const stored = writeXlsx(workbook);
    const compressed = await writeXlsxAsync(workbook);
    expect(compressed.length).toBeLessThan(stored.length);
    expect(listZip(compressed).some((e) => e.name === "xl/sharedStrings.xml")).toBe(true);

    const imported = await readXlsx(compressed);
    expect(imported.warnings).toEqual([]);
    expect(imported.workbook.definedNames).toEqual([{ name: "TaxRate", ref: "Sheet1!$B$1" }]);
    expect(imported.workbook.sheets[0].colWidths).toEqual({ 0: 24, 1: 14.5 });
    expect(imported.workbook.sheets[0].rowHeights).toEqual({ 0: 28 });
    expect(imported.workbook.sheets[0].validations).toHaveLength(2);
    expect(imported.workbook.sheets[0].hyperlinks).toEqual([{ row: 0, col: 0, target: "https://jiange.dev", tooltip: "Home" }]);

    // Test shared formula expansion + ISO date cell (t="d").
    const base = writeXlsx({ sheets: [{ name: "Calc", cells: [{ row: 0, col: 0, value: 2 }, { row: 1, col: 0, value: 3 }, { row: 0, col: 1, formula: "=A1*10" }, { row: 1, col: 1, formula: "=A2*10" }] }] });
    const withShared = await replacePart(base, "xl/worksheets/sheet1.xml", (xml) =>
      xml
        .replace('<c r="B1"><f>A1*10</f></c>', '<c r="B1"><f t="shared" ref="B1:B2" si="0">A1*10</f><v>20</v></c>')
        .replace('<c r="B2"><f>A2*10</f></c>', '<c r="B2"><f t="shared" si="0"/><v>30</v></c><c r="C2" t="d"><v>2026-11-21</v></c>'),
    );
    const parsedShared = await readXlsx(withShared);
    expect(parsedShared.workbook.sheets[0].cells).toContainEqual({ row: 0, col: 1, formula: "=A1*10", value: 20 });
    expect(parsedShared.workbook.sheets[0].cells).toContainEqual({ row: 1, col: 1, formula: "=A2*10", value: 30 });
    expect(parsedShared.workbook.sheets[0].cells).toContainEqual({ row: 1, col: 2, value: "2026-11-21" });
  });
  it("rejects shared formulas, external targets, ambiguous entries and oversized input", async () => {
    const base = writeXlsx({sheets:[{name:"Sheet1",cells:[{row:0,col:0,formula:"=1+1"}]}]});
    const shared = await replacePart(base,"xl/worksheets/sheet1.xml",(xml) => xml.replace('<f>1+1</f>','<f t="shared" si="1">1+1</f>'));
    await expect(readXlsx(shared)).rejects.toThrow(/shared, array/);
    const external = await replacePart(base,"_rels/.rels",(xml) => xml.replace('Target="xl/workbook.xml"','Target="https://example.test/evil" TargetMode="External"'));
    await expect(readXlsx(external)).rejects.toThrow(/relationship/);
    const escaping = await replacePart(base,"_rels/.rels",(xml) => xml.replace('Target="xl/workbook.xml"','Target="../../outside.xml"'));
    await expect(readXlsx(escaping)).rejects.toThrow(/escapes/);
    const duplicateType = await replacePart(base,"[Content_Types].xml",(xml) => xml.replace('</Types>','<Override PartName="/XL/WORKBOOK.XML" ContentType="application/xml"/></Types>'));
    await expect(readXlsx(duplicateType)).rejects.toThrow(/duplicate content type/);
    const ambiguous = createZip([{name:"A.xml",data:encoder.encode("a")},{name:"a.xml",data:encoder.encode("b")}]);
    await expect(readXlsx(ambiguous)).rejects.toThrow(/duplicate ZIP/);
    await expect(readXlsx(new Uint8Array(XLSX_MAX_INPUT_BYTES+1))).rejects.toBeInstanceOf(XlsxError);
  });
  it("rejects malformed XML entities and inconsistent row references", async () => {
    const base = writeXlsx({sheets:[{name:"Sheet1",cells:[{row:0,col:0,value:"A&B"}]}]});
    const badEntity = await replacePart(base,"xl/worksheets/sheet1.xml",(xml) => xml.replace('A&amp;B','A&B'));
    await expect(readXlsx(badEntity)).rejects.toBeInstanceOf(XlsxError);
    const badRow = await replacePart(base,"xl/worksheets/sheet1.xml",(xml) => xml.replace('<row r="1">','<row r="2">'));
    await expect(readXlsx(badRow)).rejects.toThrow(/disagree/);
  });
  it("rejects ambiguous workbook structures and reports hidden sheets", async () => {
    const base = writeXlsx({sheets:[{name:"First",cells:[]},{name:"Second",cells:[]}]});
    const duplicateLists = await replacePart(base,"xl/workbook.xml",(xml) => xml.replace('</sheets>','</sheets><sheets/>'));
    await expect(readXlsx(duplicateLists)).rejects.toThrow(/workbook sheets/);
    const duplicateIds = await replacePart(base,"xl/workbook.xml",(xml) => xml.replace('sheetId="2"','sheetId="1"'));
    await expect(readXlsx(duplicateIds)).rejects.toThrow(/sheet id/);
    const invalidState = await replacePart(base,"xl/workbook.xml",(xml) => xml.replace('sheetId="1"','sheetId="1" state="unknown"'));
    await expect(readXlsx(invalidState)).rejects.toThrow(/visibility/);
    const hidden = await replacePart(base,"xl/workbook.xml",(xml) => xml.replace('sheetId="1"','sheetId="1" state="hidden"'));
    expect((await readXlsx(hidden)).warnings).toContain("sheet_visibility_not_preserved");
    const macro = await replacePart(base,"[Content_Types].xml",(xml) => xml.replace('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml','application/vnd.ms-excel.sheet.macroEnabled.main+xml'));
    await expect(readXlsx(macro)).rejects.toThrow(/workbook type/);
  });
  it("reports an ambiguous empty formula cache and keeps the formula", async () => {
    const base = writeXlsx({sheets:[{name:"Sheet1",cells:[{row:0,col:0,formula:'=""'}]}]});
    const bytes = await replacePart(base,"xl/worksheets/sheet1.xml",(xml) => xml.replace('<c r="A1"><f>&quot;&quot;</f></c>', '<c r="A1" t="str"><f>&quot;&quot;</f><v></v></c>'));
    const result = await readXlsx(bytes);
    expect(result.workbook.sheets[0].cells).toEqual([{row:0,col:0,formula:'=""'}]);
    expect(result.warnings).toContain("empty_formula_cache_not_preserved");
    expect(() => writeXlsx(result.workbook)).not.toThrow();
  });
  it("round-trips conditional formats (all 10 operators + dxfs) and comments (xl/commentsN.xml) with zero warnings", async () => {
    const { writeXlsxAsync } = await import("../src/xlsx.js");
    const workbook = {
      sheets: [
        {
          name: "Review",
          cells: [
            { row: 0, col: 0, value: "Metric" },
            { row: 0, col: 1, value: "Score" },
            { row: 1, col: 0, value: "Alpha" },
            { row: 1, col: 1, value: 92 },
            { row: 2, col: 0, value: "Beta" },
            { row: 2, col: 1, value: 45 },
          ],
          hyperlinks: [{ row: 0, col: 0, target: "https://jiange.dev" }],
          conditionalFormats: [
            { id: "cf-1", top: 1, left: 1, bottom: 2, right: 1, op: "gt" as const, value1: "80", bg: "#DCFCE7", color: "#166534", bold: true },
            { id: "cf-2", top: 1, left: 1, bottom: 2, right: 1, op: "gte" as const, value1: "90", bg: "#DCFCE7", color: "#166534", bold: true },
            { id: "cf-3", top: 1, left: 1, bottom: 2, right: 1, op: "lt" as const, value1: "50", bg: "#FEE2E2" },
            { id: "cf-4", top: 1, left: 1, bottom: 2, right: 1, op: "lte" as const, value1: "60", color: "#991B1B" },
            { id: "cf-5", top: 1, left: 0, bottom: 2, right: 0, op: "eq" as const, value1: "Alpha", bold: true },
            { id: "cf-6", top: 1, left: 0, bottom: 2, right: 0, op: "neq" as const, value1: "Gamma" },
            { id: "cf-7", top: 1, left: 1, bottom: 2, right: 1, op: "between" as const, value1: "40", value2: "70", bg: "#FEF3C7" },
            { id: "cf-8", top: 1, left: 0, bottom: 2, right: 0, op: "contains" as const, value1: "Al", color: "#1E40AF" },
            { id: "cf-9", top: 3, left: 0, bottom: 3, right: 0, op: "empty" as const, bg: "#F3F4F6" },
            { id: "cf-10", top: 3, left: 1, bottom: 3, right: 1, op: "not_empty" as const, bold: true },
          ],
          comments: [
            { row: 1, col: 1, text: "Exceeds Q4 target", author: "Alice" },
            { row: 2, col: 1, text: "Needs follow-up", author: "Alice" },
            { row: 0, col: 0, text: "Anonymous note" },
          ],
        },
        {
          name: "Plain",
          cells: [{ row: 0, col: 0, value: 1 }],
        },
      ],
    };

    const bytes = await writeXlsxAsync(workbook);
    const entryNames = listZip(bytes).map((e) => e.name);
    expect(entryNames).toContain("xl/styles.xml");
    expect(entryNames).toContain("xl/comments1.xml");
    expect(entryNames).not.toContain("xl/comments2.xml");
    expect(entryNames).toContain("xl/worksheets/_rels/sheet1.xml.rels");

    const parsed = await readXlsx(bytes);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.workbook.sheets[0].conditionalFormats).toEqual(workbook.sheets[0].conditionalFormats);
    expect(parsed.workbook.sheets[0].comments).toEqual(workbook.sheets[0].comments);
    expect(parsed.workbook.sheets[0].hyperlinks).toEqual(workbook.sheets[0].hyperlinks);
    expect(parsed.workbook.sheets[1].conditionalFormats).toBeUndefined();
    expect(parsed.workbook.sheets[1].comments).toBeUndefined();
  });

  it("reads an exported worksheet at the advertised cell limit", async () => {
    const cells = Array.from({length:50_000}, (_,row) => ({row,col:0,value:"x"}));
    const result = await readXlsx(writeXlsx({sheets:[{name:"Limit",cells}]}));
    expect(result.workbook.sheets[0].cells).toHaveLength(50_000);
  });
});
