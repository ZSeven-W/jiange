import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createZip, listZip, readZipEntry } from "@jiange/ooxml/zip";
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
  it("round-trips multiple sheets, formulas, cached results and error cells", async () => {
    const workbook = { sheets: [
      { name:"计划", cells:[{row:0,col:0,value:"文本\r\n下一行"},{row:1,col:0,value:8},{row:1,col:1,formula:"=A2*2",value:16},{row:2,col:0,value:true},{row:3,col:0,value:{error:"#DIV/0!" as const}}] },
      { name:"汇总", cells:[{row:0,col:0,formula:"='计划'!B2"}] },
    ] };
    const result = await readXlsx(writeXlsx(workbook));
    expect(result.workbook).toEqual(workbook);
    expect(result.warnings).toEqual([]);
  });
  it("reads a real compressed OpenPyXL file and reports formatting loss", async () => {
    const bytes = await readFile(new URL("./fixtures/openpyxl-basic.xlsx", import.meta.url));
    const result = await readXlsx(bytes);
    expect(result.workbook.sheets.map((sheet) => sheet.name)).toEqual(["计划","汇总"]);
    expect(result.workbook.sheets[0].cells).toContainEqual({row:1,col:3,formula:"=B2*2"});
    expect(result.workbook.sheets[0].cells).toContainEqual({row:1,col:4,value:{error:"#DIV/0!"}});
    expect(result.warnings).toContain("styles_not_preserved");
    expect(result.warnings).toContain("cell_formatting_not_preserved");
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
  it("accepts equivalent namespace prefixes and warns about unsupported worksheet features", async () => {
    const base = writeXlsx({sheets:[{name:"Sheet1",cells:[{row:0,col:0,value:1}]}]});
    const bytes = await replacePart(base,"xl/worksheets/sheet1.xml",(xml) => xml.replace('xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"','xmlns:ss="http://schemas.openxmlformats.org/spreadsheetml/2006/main"').replace(/<(\/?)(worksheet|sheetData|row|c|v)(?=[\s>])/g,'<$1ss:$2').replace('</ss:worksheet>','<ss:mergeCells><ss:mergeCell ref="A1:B1"/></ss:mergeCells></ss:worksheet>'));
    const result = await readXlsx(bytes);
    expect(result.workbook.sheets[0].cells).toEqual([{row:0,col:0,value:1}]);
    expect(result.warnings).toContain("worksheet_features_not_preserved");
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
  it("reads an exported worksheet at the advertised cell limit", async () => {
    const cells = Array.from({length:50_000}, (_,row) => ({row,col:0,value:"x"}));
    const result = await readXlsx(writeXlsx({sheets:[{name:"Limit",cells}]}));
    expect(result.workbook.sheets[0].cells).toHaveLength(50_000);
  });
});
