import { describe, expect, it } from "vitest";
import { readXlsx } from "@jiange/sheet-sdk/xlsx-read";
import type { BaseRecord, Field, User } from "@/lib/api";
import { exportBaseToXlsx, parseXlsxToBaseRows, xlsxToImportCsv } from "./xlsx-io";

const fields: Field[] = [
  { id: 1, name: "任务名", type: "text", position: 1, isPrimary: true },
  { id: 2, name: "工时", type: "number", position: 2 },
  { id: 3, name: "状态", type: "select", options: ["待办", "进行中", "完成"], position: 3 },
  { id: 4, name: "标签", type: "multi_select", options: ["前端", "后端", "紧急"], position: 4 },
  { id: 5, name: "已完成", type: "checkbox", position: 5 },
  { id: 6, name: "截止日期", type: "date", position: 6 },
  { id: 7, name: "负责人", type: "person", position: 7 },
  { id: 8, name: "评分", type: "rating", position: 8 },
  { id: 9, name: "加倍工时", type: "formula", formula: "[工时]*2", position: 9 },
  { id: 10, name: "关联客户", type: "lookup", options: ["11", "12", "raw"], position: 10 },
];

const members: User[] = [
  { id: 101, name: "张三", email: "zhangsan@example.com", createdAt: "2026-01-01T00:00:00Z" },
  { id: 102, name: "李四", email: "lisi@example.com", createdAt: "2026-01-01T00:00:00Z" },
];

const records: BaseRecord[] = [
  {
    id: 1,
    baseId: 5,
    position: 1,
    cells: {
      1: "完成 Excel 导入导出",
      2: 12.5,
      3: "完成",
      4: ["前端", "后端"],
      5: true,
      6: "2026-11-24",
      7: 101,
      8: 5,
      10: ["字节跳动", "飞书团队"],
    },
  },
  {
    id: 2,
    baseId: 5,
    position: 2,
    cells: {
      1: "自动化分支测试",
      2: 4,
      3: "进行中",
      4: ["紧急"],
      5: false,
      6: "2026-12-01",
      7: 102,
      8: 4,
      10: ["基础架构"],
    },
  },
];

describe("Base Excel (.xlsx) import & export", () => {
  it("exports Base fields and records into a valid .xlsx workbook with bold header and column widths", async () => {
    const bytes = exportBaseToXlsx("研发任务:Q4/1", fields, records, members);
    expect(bytes).toBeInstanceOf(Uint8Array);
    // ZIP magic bytes PK\x03\x04
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);

    const parsed = await readXlsx(bytes);
    expect(parsed.workbook.sheets).toHaveLength(1);
    const sheet = parsed.workbook.sheets[0];
    expect(sheet.name).toBe("研发任务 Q4 1");
    expect(sheet.frozen).toEqual({ rows: 1, cols: 0 });
    expect(sheet.colWidths?.[0]).toBeGreaterThanOrEqual(10);

    const header0 = sheet.cells.find((c) => c.row === 0 && c.col === 0);
    expect(header0?.value).toBe("任务名");
    expect(header0?.style?.bold).toBe(true);

    // Formula cell evaluated and exported cleanly as a number (12.5 * 2 = 25)
    const formulaCell = sheet.cells.find((c) => c.row === 1 && c.col === 8);
    expect(formulaCell?.value).toBe(25);

    // Person cell rendered as member name
    const personCell = sheet.cells.find((c) => c.row === 1 && c.col === 6);
    expect(personCell?.value).toBe("张三");

    // Lookup cell joined cleanly
    const lookupCell = sheet.cells.find((c) => c.row === 1 && c.col === 9);
    expect(lookupCell?.value).toBe("字节跳动, 飞书团队");
  });

  it("round-trips Base -> XLSX -> parseXlsxToBaseRows accurately across all field types", async () => {
    const bytes = exportBaseToXlsx("项目排期", fields, records, members);
    const parsed = await parseXlsxToBaseRows(bytes, fields, members);

    expect(parsed.headers).toEqual(fields.map((f) => f.name));
    expect(parsed.warnings).toEqual([]);
    expect(parsed.rows).toHaveLength(2);

    expect(parsed.rows[0]).toEqual({
      "1": "完成 Excel 导入导出",
      "2": 12.5,
      "3": "完成",
      "4": ["前端", "后端"],
      "5": true,
      "6": "2026-11-24",
      "7": 101,
      "8": 5,
    });
    expect(parsed.rows[1]).toEqual({
      "1": "自动化分支测试",
      "2": 4,
      "3": "进行中",
      "4": ["紧急"],
      "5": false,
      "6": "2026-12-01",
      "7": 102,
      "8": 4,
    });
  });

  it("converts parsed XLSX into backend-compatible CSV skipping readonly formula/lookup columns", async () => {
    const bytes = exportBaseToXlsx("项目排期", fields, records, members);
    const parsed = await parseXlsxToBaseRows(bytes, fields, members);
    const { csv, skippedReadonlyHeaders } = xlsxToImportCsv(parsed, fields);

    expect(skippedReadonlyHeaders).toEqual(["加倍工时", "关联客户"]);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(3); // header + 2 rows
    expect(lines[0]).toBe("任务名,工时,状态,标签,已完成,截止日期,负责人,评分");
    expect(lines[1]).toBe("完成 Excel 导入导出,12.5,完成,前端;后端,TRUE,2026-11-24,张三,5");
    expect(lines[2]).toBe("自动化分支测试,4,进行中,紧急,FALSE,2026-12-01,李四,4");
  });
});
