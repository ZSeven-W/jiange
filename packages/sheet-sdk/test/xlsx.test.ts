import { describe, expect, it } from "vitest";
import { listZip, readZipEntry } from "@jiange/ooxml/zip";
import { writeXlsx, XlsxError, XLSX_MAX_CELLS, type XlsxWorkbook } from "../src/xlsx.js";

async function part(bytes: Uint8Array, name: string) {
  const entry = listZip(bytes).find((item) => item.name === name);
  if (!entry) throw Error(`missing ${name}`);
  return new TextDecoder().decode(await readZipEntry(bytes, entry, 1024 * 1024));
}
describe("XLSX export", () => {
  it("writes multiple sheets and preserves explicit value types and formulas", async () => {
    const workbook: XlsxWorkbook = { sheets: [
      { name: "计划 & 进度", cells: [{row:1,col:1,formula:"=A1*2",value:20},{row:0,col:0,value:10},{row:0,col:1,value:" =not a formula "},{row:1,col:0,value:true}] },
      { name: "摘要", cells: [{row:0,col:0,value:"你好 😀"}] },
    ] };
    const result = writeXlsx(workbook, { modified: new Date("2026-01-01T00:00:00Z") });
    expect((await part(result, "xl/workbook.xml"))).toContain('name="计划 &amp; 进度"');
    const sheet = await part(result, "xl/worksheets/sheet1.xml");
    expect(sheet).toContain('<c r="A1"><v>10</v></c>');
    expect(sheet).toContain('<c r="B1" t="inlineStr"><is><t xml:space="preserve"> =not a formula </t></is></c>');
    expect(sheet).toContain('<c r="A2" t="b"><v>1</v></c>');
    expect(sheet).toContain('<c r="B2"><f>A1*2</f><v>20</v></c>');
    expect(await part(result, "xl/worksheets/sheet2.xml")).toContain("你好 😀");
    expect(workbook.sheets[0].cells[0]).toMatchObject({row:1,col:1});
  });
  it("rejects unsupported data instead of silently discarding it", () => {
    const bad = (input: unknown) => expect(() => writeXlsx(input as XlsxWorkbook)).toThrow(XlsxError);
    bad({sheets:[]});
    bad({sheets:[{name:"Sheet1",cells:[]}],styles:{}});
    bad({sheets:[{name:"bad/name",cells:[]}]});
    bad({sheets:[{name:"Sheet",cells:[]},{name:"sheet",cells:[]}]});
    bad({sheets:[{name:"Sheet",cells:[{row:0,col:0,value:1},{row:0,col:0,value:2}]}]});
    bad({sheets:[{name:"Sheet",cells:[{row:1_048_576,col:0,value:1}]}]});
    bad({sheets:[{name:"Sheet",cells:[{row:0,col:16_384,value:1}]}]});
    bad({sheets:[{name:"Sheet",cells:[{row:0,col:0,value:NaN}]}]});
    bad({sheets:[{name:"Sheet",cells:[{row:0,col:0,value:{error:"#BOGUS!"}}]}]});
    bad({sheets:[{name:"Sheet",cells:[{row:0,col:0,value:Object.assign(Object.create({error:"#REF!"}),{other:1})}]}]});
    bad({sheets:[{name:"Sheet",cells:[{row:0,col:0,value:"\ud800"}]}]});
    bad({sheets:[{name:"Sheet",cells:[{row:0,col:0,value:"a\u0000b"}]}]});
    bad({sheets:[{name:"Sheet",cells:[{row:0,col:0,formula:"SUM(A1:A2)"}]}]});
    bad({sheets:[{name:"Sheet",cells:[{row:0,col:0,formula:'=""',value:""}]}]});
    bad({sheets:[{name:"Sheet",cells:[{row:0,col:0,value:1,style:{blink:true}}]}]});
    bad({sheets:[{name:"Sheet",cells:[{row:0,col:0,value:1,style:{color:"red"}}]}]});
    bad({sheets:[{name:"Sheet",cells:[],merges:[{top:0,left:0,bottom:0,right:0}]}]});
    bad({sheets:[{name:"Sheet",cells:[],merges:[{top:0,left:0,bottom:1,right:1},{top:1,left:1,bottom:2,right:2}]}]});
    bad({sheets:[{name:"Sheet",cells:[],frozen:{rows:-1,cols:0}}]});
    bad({sheets:[{name:"Sheet",cells:Array.from({length:XLSX_MAX_CELLS+1},()=>({row:0,col:0,value:1}))}]});
  });
  it("supports Excel's last address and leaves missing formula caches absent", async () => {
    const result = writeXlsx({sheets:[{name:"边界",cells:[{row:1_048_575,col:16_383,formula:"=1+1"}]}]});
    expect(await part(result,"xl/worksheets/sheet1.xml")).toContain('<c r="XFD1048576"><f>1+1</f></c>');
  });
  it("rejects files larger than its own import limit", () => {
    const cells = Array.from({length:700}, (_,row) => ({row,col:0,value:"x".repeat(30_000)}));
    expect(() => writeXlsx({sheets:[{name:"Large",cells}]})).toThrow(/export limit/);
  });
});
