import { baseApi, docsApi, driveApi, sheetsApi, type SheetCellStyle, type SheetCellWrite } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { stageStarter } from "./pending-starter";

export interface SampleWorkspaceResult {
  docId: number;
  sheetId: number;
  baseId: number;
}

function randomMutationId(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const WELCOME_MD_ZH = `## 一、欢迎来到 Jiange 协作工作区

这组示例文件帮你直观体验 Jiange 全家桶的核心能力，点击左侧栏即可随时切换查看：

- **云文档**：自研 RGA/Fugue CRDT 协同编辑、行内修订（Track Changes）、离线自动合并与多级目录大纲
- **电子表格**：WebGPU/WebGL2 虚拟网格、\`148\` 个内置公式函数、行内迷你图与浮动柱状图
- **多维表格**：\`23\` 种字段类型与 \`7\` 种视图（表格、看板、甘特、层级树、仪表盘等）

## 二、快速上手清单

- [x] 已自动创建「产品研发里程碑看板」多维表格（含看板视图）
- [x] 已自动创建「季度营收与预算示例」电子表格（含 \`=SUM\` 公式与图表）
- [ ] 点击左侧栏「知识库 AI 问答」，直接向示例工作区提问并查看原文引用

> 提示：无需配置外部 API Key，本地语义向量 + BM25 检索引擎即可直接进行跨文档问答；在顶部 AI 设置中接入 OpenAI / Anthropic 兼容模型后还可开启流式生成。`;

const WELCOME_MD_EN = `## 1. Welcome to Your Jiange Workspace

This starter workspace highlights Jiange's core modules — switch between items from the left sidebar anytime:

- **Cloud Doc**: Custom RGA/Fugue CRDT real-time & offline sync, inline Track Changes, and outline navigation
- **Sheet**: WebGPU/WebGL2 virtual grid, \`148\` built-in formula functions, sparklines, and floating charts
- **Base**: \`23\` field types and \`7\` views (Grid, Kanban, Gantt, Hierarchy Tree, and Dashboards)

## 2. Quick Checklist

- [x] Created **Product Roadmap Base** with Grid & Kanban views
- [x] Created **Quarterly Revenue Sample** sheet with live \`=SUM\` formulas & chart
- [ ] Open **Workspace AI** in the sidebar to ask questions across all workspace documents

> Tip: Hybrid local embeddings + BM25 RAG work out of the box even without an API key; configure any OpenAI / Anthropic compatible endpoint in AI Settings for full LLM streaming.`;

/**
 * Populates a brand-new user workspace with a starter Base, Sheet, and Welcome Doc
 * so first-time self-hosters can explore formulas, charts, Kanban views, and AI RAG right away.
 */
export async function createSampleWorkspace(userId: number, locale: Locale): Promise<SampleWorkspaceResult> {
  const isEn = locale === "en";

  // 1. Sample Base with curated fields, records & Kanban view
  const base = await baseApi.create(isEn ? "Product Roadmap Base" : "产品研发里程碑看板");
  const baseSnap = await baseApi.getForAccount(base.id, userId);
  const tableId = baseSnap.activeTableId;
  if (baseSnap.records.length > 0) {
    await baseApi.batchDeleteRecords(base.id, baseSnap.records.map((r) => r.id));
  }
  const primary = baseSnap.fields.find((f) => f.isPrimary) ?? baseSnap.fields[0];
  await baseApi.patchField(base.id, primary.id, { name: isEn ? "Deliverable" : "任务名称" });
  for (const field of baseSnap.fields) {
    if (field.id !== primary.id) await baseApi.deleteField(base.id, field.id);
  }
  const fStatus = await baseApi.addField(base.id, {
    name: isEn ? "Status" : "状态",
    type: "select",
    options: isEn ? ["Done", "In Progress", "Planned"] : ["已完成", "进行中", "待排期"],
    optionColors: [2, 0, 6],
  });
  const fPrio = await baseApi.addField(base.id, {
    name: isEn ? "Priority" : "优先级",
    type: "select",
    options: ["P0", "P1", "P2"],
    optionColors: [5, 4, 0],
  });
  const fOwner = await baseApi.addField(base.id, {
    name: isEn ? "Owner" : "负责人",
    type: "text",
  });
  const fProgress = await baseApi.addField(base.id, {
    name: isEn ? "Progress" : "完成进度",
    type: "progress",
  });

  const sampleRecords: [string, string, string, string, number][] = isEn
    ? [
        ["WebGPU Virtual Grid Engine", "Done", "P0", "Alex Lin", 100],
        ["Offline CRDT Auto-Merge", "Done", "P0", "Maya Chen", 100],
        ["Hybrid Vector + BM25 RAG", "In Progress", "P1", "Leo Zhou", 80],
        ["SAML 2.0 & SCIM Directory Sync", "Planned", "P1", "Chloe Xu", 35],
      ]
    : [
        ["WebGPU 百万行虚拟网格", "已完成", "P0", "林致远", 100],
        ["离线 CRDT 增量自动合并", "已完成", "P0", "陈思语", 100],
        ["知识库混合向量 RAG 问答", "进行中", "P1", "周子昂", 80],
        ["企业 SAML 2.0 & SCIM 同步", "待排期", "P1", "许嘉宁", 35],
      ];
  for (const [title, status, prio, owner, progress] of sampleRecords) {
    await baseApi.addRecord(
      base.id,
      {
        [String(primary.id)]: title,
        [String(fStatus.id)]: status,
        [String(fPrio.id)]: prio,
        [String(fOwner.id)]: owner,
        [String(fProgress.id)]: progress,
      },
      tableId,
    );
  }
  await baseApi.addViewForAccount(base.id, userId, {
    type: "kanban",
    name: isEn ? "Kanban" : "看板视图",
    ...(tableId ? { tableId } : {}),
    config: { group: fStatus.id },
  });

  // 2. Sample Sheet with formulas & floating column chart
  const sheetEntry = await driveApi.createNode("sheet", isEn ? "Quarterly Revenue Sample" : "季度营收与预算示例");
  const sheetSnap = await sheetsApi.get(sheetEntry.id, userId);
  const ws = sheetSnap.sheets[0];
  const headerStyle: SheetCellStyle = {
    bold: true,
    bg: "#eef3ff",
    color: "#1f2329",
    align: "center",
    borders: { top: true, right: true, bottom: true, left: true, color: "#dee0e3" },
  };
  const borderStyle: SheetCellStyle = {
    borders: { top: true, right: true, bottom: true, left: true, color: "#dee0e3" },
  };
  const headers = isEn
    ? ["Region", "Q1", "Q2", "Q3", "Q4", "Total"]
    : ["区域", "Q1(万)", "Q2(万)", "Q3(万)", "Q4(万)", "年度合计"];
  const regions: [string, number, number, number, number][] = isEn
    ? [
        ["North America", 268, 312, 345, 396],
        ["Europe", 195, 218, 246, 278],
        ["Asia Pacific", 224, 256, 289, 334],
      ]
    : [
        ["华东大区", 268, 312, 345, 396],
        ["华北大区", 195, 218, 246, 278],
        ["华南大区", 224, 256, 289, 334],
      ];
  const cells: SheetCellWrite[] = headers.map((label, cIdx) => ({
    rowId: ws.rows[0].id,
    columnId: ws.columns[cIdx].id,
    expectedRevision: 0,
    raw: label,
    style: headerStyle,
  }));
  regions.forEach(([name, q1, q2, q3, q4], idx) => {
    const rIdx = idx + 1;
    const rowNum = rIdx + 1;
    const values: [string, SheetCellStyle][] = [
      [name, { ...borderStyle, bold: true, align: "left" }],
      [String(q1), { ...borderStyle, align: "right" }],
      [String(q2), { ...borderStyle, align: "right" }],
      [String(q3), { ...borderStyle, align: "right" }],
      [String(q4), { ...borderStyle, align: "right" }],
      [`=SUM(B${rowNum}:E${rowNum})`, { ...borderStyle, bold: true, color: "#174ef0", align: "right" }],
    ];
    values.forEach(([raw, style], cIdx) => {
      cells.push({
        rowId: ws.rows[rIdx].id,
        columnId: ws.columns[cIdx].id,
        expectedRevision: 0,
        raw,
        style,
      });
    });
  });
  const totalRow = regions.length + 1;
  const totalCells: [string, SheetCellStyle][] = [
    [isEn ? "Total" : "总计", { ...headerStyle, bg: "#f5f6f7", align: "left" }],
    ["=SUM(B2:B4)", { ...headerStyle, bg: "#f5f6f7", align: "right" }],
    ["=SUM(C2:C4)", { ...headerStyle, bg: "#f5f6f7", align: "right" }],
    ["=SUM(D2:D4)", { ...headerStyle, bg: "#f5f6f7", align: "right" }],
    ["=SUM(E2:E4)", { ...headerStyle, bg: "#f5f6f7", align: "right" }],
    ["=SUM(F2:F4)", { ...headerStyle, bg: "#f5f6f7", color: "#174ef0", align: "right" }],
  ];
  totalCells.forEach(([raw, style], cIdx) => {
    cells.push({
      rowId: ws.rows[totalRow].id,
      columnId: ws.columns[cIdx].id,
      expectedRevision: 0,
      raw,
      style,
    });
  });
  await sheetsApi.writeCells(sheetEntry.id, userId, {
    mutationId: randomMutationId(),
    worksheetId: ws.id,
    mergeMode: "auto",
    cells,
  });
  await sheetsApi.updateWorksheet(sheetEntry.id, ws.id, userId, {
    frozenRows: 1,
    charts: [
      {
        id: "sample-revenue-chart",
        title: isEn ? "Quarterly Revenue by Region" : "各区域季度营收对比（万元）",
        type: "column",
        top: 0,
        left: 0,
        bottom: 3,
        right: 4,
        headerRow: true,
        x: 32,
        y: 196,
        width: 520,
        height: 280,
        showLegend: true,
        showValues: true,
      },
    ],
  });

  // 3. Welcome Cloud Doc staged with rich Markdown
  const doc = await docsApi.create(isEn ? "Welcome to Jiange — Quick Guide" : "欢迎使用 Jiange · 快速上手指南");
  stageStarter(userId, doc.id, isEn ? WELCOME_MD_EN : WELCOME_MD_ZH);
  await Promise.allSettled([docsApi.recordVisit(base.id), docsApi.recordVisit(sheetEntry.id)]);

  return { docId: doc.id, sheetId: sheetEntry.id, baseId: base.id };
}
