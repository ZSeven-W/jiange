import { GpuSurface, InstanceBatch, packColorRGBA } from "@jiange/render-gpu";
import { GlyphAtlas } from "@jiange/render-gpu/glyph-atlas";
import { Workbook, createSheetTools, sheetAddress } from "@jiange/sheet-sdk";
import { mountSheetView } from "@jiange/sheet-ui";
import { Document, createDocTools } from "@jiange/doc-sdk";
import { mountDocView } from "@jiange/doc-ui";
import { Presentation, createSlidesTools } from "@jiange/slides-sdk";
import { mountSlidesView } from "@jiange/slides-ui";
import { Board, createWhiteboardTools } from "@jiange/whiteboard-sdk";
import { mountWhiteboardView } from "@jiange/whiteboard-ui";
import { Base, createBaseTools } from "@jiange/base-sdk";
import { mountBaseView } from "@jiange/base-ui";

// ---------------------------------------------------------------------------
// DOM Refs & Global Playground State
// ---------------------------------------------------------------------------

const stageEl = document.getElementById("stage");
const controlsEl = document.getElementById("controls");
const tabButtons = Array.from(document.querySelectorAll(".tab-btn"));

const pillBackend = document.getElementById("pill-backend");
const valBackend = document.getElementById("val-backend");
const valDraws = document.getElementById("val-draws");
const valInstances = document.getElementById("val-instances");
const valFrame = document.getElementById("val-frame");

const state = {
  activeTab: "sheet",
  backend: "init",
  stats: {
    backend: "init",
    drawCalls: 0,
    rectInstances: 0,
    lineInstances: 0,
    arcInstances: 0,
    glyphInstances: 0,
    frameTimeMs: 0,
  },
  tabMetrics: {},
  lastAiResult: null,
  errors: [],
};

window.addEventListener("error", (ev) => {
  state.errors.push(String(ev.message || ev.error || "Unknown error"));
});

window.addEventListener("unhandledrejection", (ev) => {
  state.errors.push(String(ev.reason || "Unhandled promise rejection"));
});

let activeSession = null;
let mountToken = 0;

// ---------------------------------------------------------------------------
// Shared UI Helpers
// ---------------------------------------------------------------------------

function updateTelemetry(stats, tabMetrics = null) {
  const backend = stats.backend || "headless";
  const rectInstances = stats.rectInstances ?? 0;
  const lineInstances = stats.lineInstances ?? 0;
  const arcInstances = stats.arcInstances ?? 0;
  const glyphInstances = stats.glyphInstances ?? 0;
  const totalInstances = rectInstances + lineInstances + arcInstances + glyphInstances;
  const drawCalls = stats.drawCalls ?? 0;
  const frameTimeMs = Number.isFinite(stats.frameTimeMs) ? stats.frameTimeMs : 0;

  state.backend = backend;
  state.stats = {
    backend,
    drawCalls,
    rectInstances,
    lineInstances,
    arcInstances,
    glyphInstances,
    frameTimeMs,
  };
  if (tabMetrics) {
    state.tabMetrics = { ...tabMetrics };
  }

  pillBackend.dataset.kind = backend;
  valBackend.textContent = backend;
  valDraws.textContent = String(drawCalls);
  valInstances.textContent = totalInstances.toLocaleString();
  valFrame.textContent = `${frameTimeMs.toFixed(2)} ms`;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "className") node.className = v;
    else if (k === "textContent") node.textContent = v;
    else if (k === "dataset" && v && typeof v === "object") {
      for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = String(dv);
    } else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v !== undefined && v !== null) {
      node.setAttribute(k, String(v));
    }
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function createDrawerShell(title, pkgName, description) {
  controlsEl.replaceChildren();
  const header = el("div", { className: "drawer-header" }, [
    el("div", { className: "drawer-title-row" }, [
      el("h2", { textContent: title }),
      el("span", { className: "pkg-chip", textContent: pkgName }),
    ]),
    el("p", { className: "drawer-desc", textContent: description }),
  ]);
  controlsEl.appendChild(header);
}

function createCard(title, children = []) {
  const card = el("div", { className: "card" }, [
    el("h3", { className: "card-title", textContent: title }),
    ...children,
  ]);
  controlsEl.appendChild(card);
  return card;
}

function createMetricGrid(items) {
  const refs = {};
  const grid = el("div", { className: "metrics-grid" });
  for (const [key, label, initial = "—"] of items) {
    const valEl = el("span", { className: "metric-value", textContent: String(initial) });
    refs[key] = valEl;
    grid.appendChild(
      el("div", { className: "metric-item" }, [
        el("span", { className: "metric-label", textContent: label }),
        valEl,
      ]),
    );
  }
  return { grid, refs };
}

function createAiConsole(initialText = "Run an AI tool above to inspect live SDK diagnostics and JSON output.") {
  const pre = el("pre", { className: "ai-console", textContent: initialText });
  createCard("AI Tool Output", [pre]);
  return {
    set(label, payload) {
      state.lastAiResult = { label, payload };
      const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
      pre.textContent = `// ${label}\n${text}`;
    },
  };
}

function observeResize(target, onResize) {
  const ro = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const w = Math.floor(entry.contentRect.width);
      const h = Math.floor(entry.contentRect.height);
      if (w > 0 && h > 0) onResize(w, h);
    }
  });
  ro.observe(target);
  return () => ro.disconnect();
}

// ---------------------------------------------------------------------------
// Tab 1: Sheet (GPU + Virtual2D)
// ---------------------------------------------------------------------------

function buildDefaultWorkbook() {
  const wb = Workbook.create({
    sheets: [{ name: "Revenue", rows: 60, cols: 12 }],
  });
  const s = wb.sheet(0);
  s.setFreeze(1, 1);

  const widths = [148, 108, 86, 104, 118, 118, 108];
  widths.forEach((w, idx) => s.setColWidth(idx, w));

  const headers = ["Product", "Region", "Seats", "Unit ($)", "Revenue", "Margin (68%)", "Status"];
  headers.forEach((h, idx) => {
    s.setCell(sheetAddress({ row: 0, col: idx }), h, { bold: true, bg: "#eef3ff" });
  });

  const rows = [
    ["Jiange Cloud", "NA", 145, 420, "=C2*D2", "=ROUND(E2*0.68,2)", "Closed"],
    ["Jiange Docs", "EU", 210, 260, "=C3*D3", "=ROUND(E3*0.68,2)", "Closed"],
    ["Jiange Sheet", "APAC", 180, 340, "=C4*D4", "=ROUND(E4*0.68,2)", "Closed"],
    ["Jiange Base", "NA", 96, 510, "=C5*D5", "=ROUND(E5*0.68,2)", "Review"],
    ["Jiange Slides", "EU", 130, 290, "=C6*D6", "=ROUND(E6*0.68,2)", "Closed"],
    ["Whiteboard AI", "APAC", 160, 310, "=C7*D7", "=ROUND(E7*0.68,2)", "Open"],
    ["Render GPU SDK", "NA", 84, 780, "=C8*D8", "=ROUND(E8*0.68,2)", "Closed"],
    ["Collab CRDT", "LATAM", 112, 360, "=C9*D9", "=ROUND(E9*0.68,2)", "Open"],
    ["OOXML Engine", "EU", 75, 490, "=C10*D10", "=ROUND(E10*0.68,2)", "Closed"],
    ["AI Copilot", "NA", 240, 320, "=C11*D11", "=ROUND(E11*0.68,2)", "Closed"],
  ];

  s.setRange("A2", rows);
  s.setCell("A12", "Subtotal", { bold: true, bg: "#f7f9fc" });
  s.setCell("C12", "=SUM(C2:C11)", { bold: true, bg: "#f7f9fc" });
  s.setCell("D12", "=ROUND(AVERAGE(D2:D11),2)", { bold: true, bg: "#f7f9fc" });
  s.setCell("E12", "=SUM(E2:E11)", { bold: true, bg: "#eef3ff" });
  s.setCell("F12", "=SUM(F2:F11)", { bold: true, bg: "#eef3ff" });
  s.setCell("G12", "Verified", { bold: true, bg: "#e8ffea" });

  s.addConditionalFormat({
    top: 1,
    left: 4,
    bottom: 10,
    right: 4,
    op: "gte",
    value1: "55000",
    bg: "#e8ffea",
    bold: true,
  });

  return wb;
}

function buildStressWorkbook10k() {
  const rowCount = 10000;
  const colCount = 9;
  const rows = Array.from({ length: rowCount }, (_, i) => ({ id: i + 1, pos: i }));
  const colWidths = [110, 90, 108, 84, 96, 114, 104, 96, 130];
  const columns = Array.from({ length: colCount }, (_, i) => ({
    id: i + 1,
    pos: i,
    size: colWidths[i] ?? 108,
  }));

  const cells = [];
  const headers = ["Row ID", "Region", "Owner", "Units", "Price", "Revenue", "Target", "Status", "AI Rollup"];
  headers.forEach((h, c) => {
    cells.push({ rowId: 1, columnId: c + 1, raw: h, style: { bold: true, bg: "#eef3ff" }, revision: 1 });
  });

  const regions = ["NA", "EU", "APAC", "LATAM"];
  for (let r = 2; r <= rowCount; r++) {
    const units = (r % 50) + 1;
    const price = 120 + (r % 80);
    cells.push(
      { rowId: r, columnId: 1, raw: `ROW-${r - 1}`, revision: 1 },
      { rowId: r, columnId: 2, raw: regions[r % 4], revision: 1 },
      { rowId: r, columnId: 3, raw: `Rep ${(r % 40) + 1}`, revision: 1 },
      { rowId: r, columnId: 4, raw: String(units), revision: 1 },
      { rowId: r, columnId: 5, raw: String(price), revision: 1 },
      { rowId: r, columnId: 6, raw: String(units * price), revision: 1 },
      { rowId: r, columnId: 7, raw: "4000", revision: 1 },
      { rowId: r, columnId: 8, raw: r % 3 === 0 ? "Closed" : "Open", revision: 1 },
    );
  }

  return Workbook.fromSnapshot([
    {
      id: 1,
      nodeId: 0,
      title: "Stress10K",
      pos: 0,
      frozenRows: 1,
      frozenCols: 1,
      merges: [],
      filter: {},
      revision: 1,
      rows,
      columns,
      cells,
    },
  ]);
}

async function mountSheetTab(token) {
  let stressMode = false;
  let inlineChartVisible = false;
  let mounted = null;
  let workbook = null;
  let tools = null;
  let stopResize = null;
  let buildMs = 0;

  stageEl.replaceChildren();
  const host = el("div", { className: "stage-mount sheet-stage-wrap", tabindex: "0" });
  stageEl.appendChild(host);

  createDrawerShell(
    "Spreadsheet Engine",
    "@jiange/sheet-ui",
    "4-quadrant WebGPU/WebGL2 frozen panes + Fenwick VirtualGrid2D + incremental formula DAG.",
  );

  const stressBtn = el("button", { className: "btn btn-toggle", textContent: "10,000 Rows Stress: OFF" });
  const inspectBtn = el("button", { className: "btn", textContent: "AI sheet_inspect" });
  const applyBtn = el("button", { className: "btn btn-primary", textContent: "AI sheet_apply (=SUM)" });
  const chartBtn = el("button", { className: "btn btn-toggle", textContent: "Inline GPU Chart: OFF" });

  createCard("Interactive & AI Controls", [
    el("div", { className: "btn-row" }, [stressBtn, chartBtn]),
    el("div", { className: "btn-row" }, [inspectBtn, applyBtn]),
    el("p", {
      className: "hint-text",
      textContent: "Wheel to scroll 10k rows smoothly; click cells or double-click / press Enter for inline IME editing.",
    }),
  ]);

  const { grid: metricsGrid, refs: m } = createMetricGrid([
    ["cellAddr", "Active Cell", "A1"],
    ["cellValue", "Evaluated Value", "—"],
    ["cellRaw", "Raw / Formula", "—"],
    ["dimensions", "Grid Size", "—"],
    ["gpuInst", "GPU Rects / Lines", "—"],
    ["poolCount", "Pooled DOM Cells", "—"],
  ]);
  createCard("Live Cell & GPU Telemetry", [metricsGrid]);

  const aiOut = createAiConsole();

  function syncUi(frame) {
    if (!mounted || !workbook) return;
    const ctrl = mounted.controller;
    const sel = ctrl.getSelection();
    const proxy = workbook.sheet(0);
    const a1 = sheetAddress({ row: sel.anchorRow, col: sel.anchorCol });
    const cell = proxy.getCell(a1);
    const stats = frame?.gpu || ctrl.renderer.surface.stats || {
      backend: ctrl.renderer.surface.backendKind,
      drawCalls: 0,
      rectInstances: 0,
      lineInstances: 0,
      arcInstances: 0,
      glyphInstances: 0,
      frameTimeMs: 0,
    };

    m.cellAddr.textContent = a1;
    m.cellValue.textContent = cell.formatted || "(empty)";
    m.cellRaw.textContent = cell.raw || "(empty)";
    m.dimensions.textContent = `${proxy.rowCount.toLocaleString()} × ${proxy.colCount}`;
    m.gpuInst.textContent = `${stats.rectInstances}r / ${stats.lineInstances}l / ${stats.arcInstances}a`;
    m.poolCount.textContent = `${ctrl.renderer.grid.pool.activeCount} active (${ctrl.renderer.grid.pool.totalCreated} created)`;

    updateTelemetry(stats, {
      sheetName: proxy.name,
      stressMode,
      rowCount: proxy.rowCount,
      colCount: proxy.colCount,
      buildMs: Number(buildMs.toFixed(1)),
      activeCell: a1,
      activeCellRaw: cell.raw,
      activeCellFormatted: cell.formatted,
      mountedTextCells: frame?.mountedTextCells ?? ctrl.renderer.grid.pool.activeCount,
      poolCreated: ctrl.renderer.grid.pool.totalCreated,
    });
  }

  const onHostWheel = () => {
    if (mounted) syncUi();
  };
  const onHostKey = () => {
    if (mounted) syncUi();
  };
  host.addEventListener("wheel", onHostWheel, { passive: true });
  host.addEventListener("keyup", onHostKey);

  async function mountWorkbook(isStress) {
    if (mounted) {
      mounted.dispose();
      mounted = null;
    }
    const t0 = performance.now();
    workbook = isStress ? buildStressWorkbook10k() : buildDefaultWorkbook();
    buildMs = performance.now() - t0;
    tools = createSheetTools(workbook);
    inlineChartVisible = false;
    chartBtn.classList.remove("active");
    chartBtn.textContent = "Inline GPU Chart: OFF";

    const view = await mountSheetView(host, workbook, {
      onSelectionChange: () => syncUi(),
      onEditCommit: () => syncUi(),
    });

    if (token !== mountToken) {
      view.dispose();
      return;
    }

    mounted = view;
    if (!isStress) {
      mounted.controller.setCollaborators([
        { id: "ai-agent", name: "Jiange AI", color: "#00b42a", row: 1, col: 4 },
      ]);
    }
    mounted.resize(host.clientWidth || 860, host.clientHeight || 560);
    const frame = mounted.controller.render();
    syncUi(frame);
  }

  function runInspect() {
    if (!tools) return null;
    const res = tools.execute("sheet_inspect", { detail: "summary" });
    aiOut.set("sheet_inspect", res);
    return res;
  }

  function runApplySum() {
    if (!tools || !mounted || !workbook) return null;
    const sheetName = workbook.sheet(0).name;
    let targetA1;
    let ops;
    if (stressMode) {
      targetA1 = "I2";
      ops = [
        {
          op: "setCells",
          sheet: sheetName,
          cells: [
            { a1: "I2", raw: "=SUM(F2:F10000)", style: { bold: true, bg: "#fff3e5" } },
            { a1: "I3", raw: "=AVERAGE(F2:F10000)", style: { bg: "#eef3ff" } },
          ],
        },
      ];
    } else {
      targetA1 = "E14";
      ops = [
        {
          op: "setCells",
          sheet: sheetName,
          cells: [
            { a1: "A14", raw: "AI Q4 Forecast (+15%)", style: { bold: true, bg: "#fff3e5" } },
            { a1: "E14", raw: "=SUM(E2:E11)*1.15", style: { bold: true, bg: "#fff3e5" } },
            { a1: "F14", raw: "=SUM(F2:F11)*1.15", style: { bold: true, bg: "#fff3e5" } },
          ],
        },
      ];
    }

    const res = tools.execute("sheet_apply", {
      ops,
      reason: "AI playground SUM formula injection",
    });
    const pt = stressMode ? { row: 1, col: 8 } : { row: 13, col: 4 };
    mounted.controller.selectCell(pt.row, pt.col);
    const frame = mounted.controller.render();
    syncUi(frame);

    const evaluated = workbook.sheet(0).getCell(targetA1);
    aiOut.set(`sheet_apply -> ${targetA1}`, {
      cell: targetA1,
      raw: evaluated.raw,
      evaluated: evaluated.formatted,
      ok: res.ok,
      diffCount: res.diff?.cellChanges?.length ?? 0,
      diagnostics: res.diagnostics,
    });
    return { res, cell: targetA1, evaluated };
  }

  async function toggleStress() {
    stressMode = !stressMode;
    stressBtn.classList.toggle("active", stressMode);
    stressBtn.textContent = stressMode ? "10,000 Rows Stress: ON" : "10,000 Rows Stress: OFF";
    await mountWorkbook(stressMode);
    aiOut.set(
      stressMode ? "Stress Mode Enabled (10,000 Rows)" : "Default Mode Restored",
      {
        rows: workbook.sheet(0).rowCount,
        cols: workbook.sheet(0).colCount,
        buildTimeMs: Number(buildMs.toFixed(1)),
      },
    );
  }

  function toggleInlineChart() {
    if (!workbook || !mounted) return;
    const proxy = workbook.sheet(0);
    const ws = workbook._getWorksheetById(proxy.id);
    if (!ws) return;
    inlineChartVisible = !inlineChartVisible;
    if (inlineChartVisible) {
      ws.charts = [];
      proxy.addChart({
        title: "Revenue & Margin by Product",
        type: "bar",
        top: 0,
        left: stressMode ? 4 : 3,
        bottom: stressMode ? 8 : 10,
        right: stressMode ? 6 : 5,
        headerRow: true,
        x: 16,
        y: stressMode ? 320 : 356,
        width: 460,
        height: 210,
        showLegend: true,
      });
    } else {
      ws.charts = [];
      ws.revision++;
      workbook._bumpVersion();
    }
    chartBtn.classList.toggle("active", inlineChartVisible);
    chartBtn.textContent = inlineChartVisible ? "Inline GPU Chart: ON" : "Inline GPU Chart: OFF";
    const frame = mounted.controller.render();
    syncUi(frame);
  }

  stressBtn.addEventListener("click", () => { void toggleStress(); });
  inspectBtn.addEventListener("click", runInspect);
  applyBtn.addEventListener("click", runApplySum);
  chartBtn.addEventListener("click", toggleInlineChart);

  await mountWorkbook(false);
  if (token !== mountToken) return null;

  stopResize = observeResize(host, (w, h) => {
    if (!mounted) return;
    mounted.resize(w, h);
    syncUi();
  });

  return {
    async runAction(name) {
      if (name === "toggleStress") { await toggleStress(); return state.tabMetrics; }
      if (name === "inspect") return runInspect();
      if (name === "applySum") return runApplySum();
      if (name === "toggleChart") { toggleInlineChart(); return state.tabMetrics; }
      return null;
    },
    dispose() {
      stopResize?.();
      host.removeEventListener("wheel", onHostWheel);
      host.removeEventListener("keyup", onHostKey);
      mounted?.dispose();
      mounted = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Tab 2: Doc (Virtual1D)
// ---------------------------------------------------------------------------

const DEFAULT_DOC_MARKDOWN = `# Jiange AI-Native GPU UI Architecture

Jiange separates collaborative data models from high-frequency rendering primitives. Every UI view operates with zero Canvas 2D usage and deterministic AI tool facades.

## 1. Zero-Churn VirtualList1D Engine

Long technical documents with 5,000+ blocks maintain constant 60fps scrolling by pairing a Fenwick prefix-sum tree with a recycled DOM node pool.

- O(log N) dynamic block height updates via ResizeObserver feedback
- Zero DOM node creation or destruction during steady-state scrolling
- Strict GPU-composited translate3d positioning with CSS containment

## 2. WebGPU Primary & WebGL2 Automatic Fallback

All geometric surfaces share @jiange/render-gpu: instanced SDF rounded rectangles, dashed lines, pie/donut arcs, and shelf-packed R8 bitmap glyphs.

\`\`\`ts
const surface = await GpuSurface.create(canvas, { prefer: "webgpu" });
const batch = new InstanceBatch(1024, 1024, 256, 2048);
batch.pushText(surface.glyphAtlas, "ZERO CANVAS 2D", 24, 24, 18, [0.2, 0.44, 1, 1]);
surface.render([batch]);
\`\`\`

## 3. Collaborative CRDT & AI Tools

> Documents expose token-budgeted inspect(), targeted readSection(), atomic apply() with dryRun previews, and deterministic verify() checks.

### Structured Editing Operations

Agents never rewrite whole markdown files blindly. They emit atomic block operations (insertBlock, updateBlock, replaceText, addSuggestion) with instant undo tokens.

## 4. Verification & Telemetry

Every SDK ships deterministic diagnostics and frame telemetry so both engineers and autonomous agents can verify layout integrity programmatically.
`;

function buildStressDocument5k() {
  const blocks = [
    {
      type: "h1",
      text: "5,000-Block Virtual1D Stress Specification",
      props: {},
      spans: [{ text: "5,000-Block Virtual1D Stress Specification", marks: {} }],
    },
  ];
  for (let i = 1; i < 5000; i++) {
    if (i % 250 === 0) {
      const secNum = i / 250;
      const heading = `Section ${secNum}: Scaled Subsystem #${secNum} (Block ${i})`;
      blocks.push({
        type: "h2",
        text: heading,
        props: {},
        spans: [{ text: heading, marks: {} }],
      });
    } else if (i % 50 === 0) {
      const code = `const frame_${i} = list.update(scrollTop, viewportH, viewportW, renderBlock); // block #${i}`;
      blocks.push({
        type: "code",
        text: code,
        props: {},
        spans: [{ text: code, marks: {} }],
      });
    } else {
      const txt = `Block #${i} — Recycled VirtualList1D paragraph managed by O(log N) FenwickVirtualizer without allocating 5,000 DOM nodes.`;
      blocks.push({
        type: "paragraph",
        text: txt,
        props: {},
        spans: [{ text: txt, marks: {} }],
      });
    }
  }
  return Document.create({ title: "5,000-Block Virtual1D Stress Specification", blocks });
}

async function mountDocTab(token) {
  let stressMode = false;
  let docModel = null;
  let tools = null;
  let mounted = null;
  let stopResize = null;
  let buildMs = 0;

  stageEl.replaceChildren();
  const shell = el("div", { className: "doc-stage-shell" });
  const paper = el("div", { className: "doc-paper", tabindex: "0" });
  shell.appendChild(paper);
  stageEl.appendChild(shell);

  createDrawerShell(
    "Block Document View",
    "@jiange/doc-ui",
    "O(log N) Fenwick VirtualList1D over CRDT-backed Document with outline jumps and AI inspection.",
  );

  const stressBtn = el("button", { className: "btn btn-toggle", textContent: "5,000 Blocks Stress: OFF" });
  const inspectBtn = el("button", { className: "btn btn-primary", textContent: "AI doc_inspect" });
  const insertBtn = el("button", { className: "btn", textContent: "AI doc_apply (+Block)" });

  createCard("Document & AI Controls", [
    el("div", { className: "btn-row" }, [stressBtn]),
    el("div", { className: "btn-row" }, [inspectBtn, insertBtn]),
  ]);

  const outlineContainer = el("div", { className: "outline-list" });
  createCard("Outline Heading Jumps", [outlineContainer]);

  const { grid: metricsGrid, refs: m } = createMetricGrid([
    ["totalBlocks", "Total Blocks", "0"],
    ["visibleRange", "Visible Range", "0..0"],
    ["activePool", "Active DOM Nodes", "0"],
    ["recycled", "Recycled / Created", "0 / 0"],
    ["scrollTop", "Scroll Offset", "0 px"],
    ["totalHeight", "Virtual Height", "0 px"],
  ]);
  createCard("VirtualList1D Telemetry", [metricsGrid]);

  const aiOut = createAiConsole();

  function syncUi(frame, frameMs = 0) {
    if (!mounted || !docModel) return;
    const ctrl = mounted.controller;
    const pool = ctrl.list.pool;
    const totalBlocks = ctrl.list.sizes.itemCount;
    const start = frame?.start ?? 0;
    const end = frame?.end ?? 0;
    const visibleCount = frame?.visibleCount ?? pool.activeCount;
    const totalHeight = frame?.totalHeight ?? ctrl.list.sizes.totalSize;

    m.totalBlocks.textContent = totalBlocks.toLocaleString();
    m.visibleRange.textContent = `${start}..${end} (${visibleCount})`;
    m.activePool.textContent = String(pool.activeCount);
    m.recycled.textContent = `${pool.totalRecycled} / ${pool.totalCreated}`;
    m.scrollTop.textContent = `${Math.round(ctrl.getScrollTop()).toLocaleString()} px`;
    m.totalHeight.textContent = `${Math.round(totalHeight).toLocaleString()} px`;

    updateTelemetry(
      {
        backend: "virtual-1d",
        drawCalls: 1,
        rectInstances: pool.activeCount,
        lineInstances: 0,
        arcInstances: 0,
        glyphInstances: 0,
        frameTimeMs: frameMs,
      },
      {
        stressMode,
        totalBlocks,
        visibleStart: start,
        visibleEnd: end,
        visibleCount,
        poolActive: pool.activeCount,
        poolCreated: pool.totalCreated,
        poolRecycled: pool.totalRecycled,
        scrollTop: Math.round(ctrl.getScrollTop()),
        buildMs: Number(buildMs.toFixed(1)),
      },
    );
  }

  function rebuildOutline() {
    outlineContainer.replaceChildren();
    if (!docModel || !mounted) return;
    const headings = docModel.outline();
    const picks = headings.length <= 12
      ? headings
      : [
          ...headings.slice(0, 4),
          headings[Math.floor(headings.length * 0.25)],
          headings[Math.floor(headings.length * 0.5)],
          headings[Math.floor(headings.length * 0.75)],
          ...headings.slice(-3),
        ].filter((v, idx, arr) => v && arr.findIndex((x) => x.id === v.id) === idx);

    for (const h of picks) {
      const btn = el("button", {
        className: "btn btn-sm outline-btn",
        textContent: `${"· ".repeat(Math.max(0, h.level - 1))}${h.text}`,
        onClick: () => {
          const t0 = performance.now();
          const frame = mounted.controller.jumpToHeading(h.id);
          syncUi(frame, performance.now() - t0);
        },
      });
      outlineContainer.appendChild(btn);
    }
  }

  const onPaperWheel = () => {
    if (!mounted) return;
    const t0 = performance.now();
    const frame = mounted.controller.render();
    syncUi(frame, performance.now() - t0);
  };
  paper.addEventListener("wheel", onPaperWheel, { passive: true });

  function mountDoc(isStress) {
    if (mounted) {
      mounted.dispose();
      mounted = null;
    }
    const t0 = performance.now();
    docModel = isStress ? buildStressDocument5k() : Document.fromMarkdown(DEFAULT_DOC_MARKDOWN);
    buildMs = performance.now() - t0;
    tools = createDocTools(docModel);

    mounted = mountDocView(paper, docModel);
    const rt0 = performance.now();
    mounted.resize(paper.clientWidth || 760, paper.clientHeight || 560);
    const frame = mounted.controller.render();
    rebuildOutline();
    syncUi(frame, performance.now() - rt0);
  }

  function runInspect() {
    if (!tools) return null;
    const res = tools.execute("doc_inspect", { detail: "summary" });
    aiOut.set("doc_inspect", {
      title: res.summary.title,
      blockCount: res.summary.blockCount,
      wordCount: res.summary.wordCount,
      headingCount: res.summary.headingCount,
      estimatedTokens: res.estimatedTokens,
      outlinePreview: res.summary.outline.slice(0, 6).map((o) => ({ blockIndex: o.blockIndex, text: o.text })),
    });
    return res;
  }

  function runInsertBlock() {
    if (!tools || !mounted) return null;
    const blocks = docModel.blocks();
    const firstId = blocks[0]?.id ?? null;
    const res = tools.execute("doc_apply", {
      ops: [
        {
          op: "insertBlock",
          type: "quote",
          text: `AI Summary Note (v${docModel.version + 1}): Verified ${blocks.length.toLocaleString()} blocks in VirtualList1D with zero DOM churn.`,
          afterBlockId: firstId,
        },
      ],
      reason: "Playground AI callout insert",
    });
    const t0 = performance.now();
    const frame = mounted.controller.setScrollTop(0);
    rebuildOutline();
    syncUi(frame, performance.now() - t0);
    aiOut.set("doc_apply", res);
    return res;
  }

  function toggleStress() {
    stressMode = !stressMode;
    stressBtn.classList.toggle("active", stressMode);
    stressBtn.textContent = stressMode ? "5,000 Blocks Stress: ON" : "5,000 Blocks Stress: OFF";
    mountDoc(stressMode);
    aiOut.set(
      stressMode ? "5,000-Block Stress Document Ready" : "Default Architecture RFC Restored",
      {
        blockCount: docModel.blocks().length,
        buildTimeMs: Number(buildMs.toFixed(1)),
        activeDomNodes: mounted.controller.list.pool.activeCount,
      },
    );
  }

  stressBtn.addEventListener("click", toggleStress);
  inspectBtn.addEventListener("click", runInspect);
  insertBtn.addEventListener("click", runInsertBlock);

  mountDoc(false);
  if (token !== mountToken) {
    mounted?.dispose();
    return null;
  }

  stopResize = observeResize(paper, (w, h) => {
    if (!mounted) return;
    const t0 = performance.now();
    mounted.resize(w, h);
    syncUi(mounted.controller.render(), performance.now() - t0);
  });

  return {
    runAction(name, payload) {
      if (name === "toggleStress") { toggleStress(); return state.tabMetrics; }
      if (name === "inspect") return runInspect();
      if (name === "insertBlock") return runInsertBlock();
      if (name === "jumpHeading" && mounted) {
        const t0 = performance.now();
        const frame = mounted.controller.jumpToHeading(String(payload || ""));
        syncUi(frame, performance.now() - t0);
        return state.tabMetrics;
      }
      return null;
    },
    dispose() {
      stopResize?.();
      paper.removeEventListener("wheel", onPaperWheel);
      mounted?.dispose();
      mounted = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Tab 3: Slides (GPU Stage + Side-by-Side Deterministic SVG)
// ---------------------------------------------------------------------------

function buildSampleDeck() {
  const deck = Presentation.create({
    title: "Jiange GPU Slides Engine",
    initialSlide: false,
  });

  deck.addSlide({
    title: "Jiange AI-Native GPU Stack",
    background: "#ffffff",
    layout: "blank",
    shapes: [
      { id: "s1-banner", kind: "rounded-rectangle", x: 5, y: 7, width: 90, height: 18, color: "#3370ff" },
      { id: "s1-title", kind: "text", x: 8, y: 11, width: 80, height: 10, color: "#ffffff", text: "Jiange AI-Native UI SDK", fontSize: 30, bold: true },
      { id: "s1-card1", kind: "rounded-rectangle", x: 5, y: 31, width: 28, height: 48, color: "#eef3ff" },
      { id: "s1-card2", kind: "rounded-rectangle", x: 36, y: 31, width: 28, height: 48, color: "#e8ffea" },
      { id: "s1-card3", kind: "rounded-rectangle", x: 67, y: 31, width: 28, height: 48, color: "#fff3e5" },
      { id: "s1-dot1", kind: "ellipse", x: 14, y: 38, width: 10, height: 17, color: "#3370ff" },
      { id: "s1-dot2", kind: "ellipse", x: 45, y: 38, width: 10, height: 17, color: "#00b42a" },
      { id: "s1-dot3", kind: "ellipse", x: 76, y: 38, width: 10, height: 17, color: "#ff7d00" },
      { id: "s1-conn1", kind: "line-arrow", x: 33, y: 54, width: 3, height: 2, color: "#64748b", strokeWidth: 3 },
      { id: "s1-conn2", kind: "line-arrow", x: 64, y: 54, width: 3, height: 2, color: "#64748b", strokeWidth: 3 },
      { id: "s1-txt1", kind: "text", x: 7, y: 60, width: 24, height: 14, color: "#1f2329", text: "WebGPU + WebGL2 SDF", fontSize: 16, align: "center" },
      { id: "s1-txt2", kind: "text", x: 38, y: 60, width: 24, height: 14, color: "#1f2329", text: "Pooled Virtualization", fontSize: 16, align: "center" },
      { id: "s1-txt3", kind: "text", x: 69, y: 60, width: 24, height: 14, color: "#1f2329", text: "Deterministic AI Tools", fontSize: 16, align: "center" },
    ],
  });

  deck.addSlide({
    title: "Q4 Render Telemetry & Benchmarks",
    background: "#f9fbff",
    layout: "blank",
    shapes: [
      { id: "s2-head", kind: "text", x: 5, y: 6, width: 90, height: 10, color: "#1f2329", text: "Q4 Render Telemetry & Benchmarks", fontSize: 26, bold: true },
      {
        id: "s2-chart",
        kind: "chart",
        x: 5,
        y: 22,
        width: 44,
        height: 62,
        color: "#3370ff",
        chart: {
          type: "column",
          title: "Throughput (k instances/frame)",
          categories: ["Sheet", "Doc", "Slides", "Board", "Base"],
          series: [{ name: "GPU", values: [92, 68, 84, 96, 88], color: "#3370ff" }],
        },
      },
      {
        id: "s2-table",
        kind: "table",
        x: 53,
        y: 22,
        width: 42,
        height: 44,
        color: "#3370ff",
        table: {
          headerRow: true,
          rows: [
            ["Package", "Backend", "Draw Calls"],
            ["sheet-ui", "WebGPU/GL2", "5"],
            ["slides-ui", "WebGPU/GL2", "3"],
            ["base-ui", "WebGPU/GL2", "2-3"],
          ],
        },
      },
      { id: "s2-callout", kind: "rounded-rectangle", x: 53, y: 70, width: 42, height: 14, color: "#e8ffea" },
      { id: "s2-callout-t", kind: "text", x: 55, y: 73, width: 38, height: 8, color: "#007a1d", text: "Zero Canvas 2D Context Allocations", fontSize: 15, bold: true },
    ],
  });

  deck.addSlide({
    title: "Multi-Surface Agent Pipeline",
    background: "#ffffff",
    layout: "blank",
    shapes: [
      { id: "s3-head", kind: "text", x: 6, y: 7, width: 88, height: 10, color: "#1f2329", text: "Multi-Surface Agent Pipeline", fontSize: 26, bold: true },
      { id: "s3-n1", kind: "rounded-rectangle", x: 6, y: 34, width: 22, height: 26, color: "#3370ff" },
      { id: "s3-n2", kind: "rounded-rectangle", x: 39, y: 34, width: 22, height: 26, color: "#722ed1" },
      { id: "s3-n3", kind: "rounded-rectangle", x: 72, y: 34, width: 22, height: 26, color: "#00b42a" },
      { id: "s3-l1", kind: "line-arrow", x: 28, y: 46, width: 11, height: 2, color: "#3370ff", strokeWidth: 4 },
      { id: "s3-l2", kind: "line-arrow", x: 61, y: 46, width: 11, height: 2, color: "#722ed1", strokeWidth: 4 },
      { id: "s3-t1", kind: "text", x: 8, y: 43, width: 18, height: 10, color: "#ffffff", text: "Inspect", fontSize: 18, bold: true, align: "center" },
      { id: "s3-t2", kind: "text", x: 41, y: 43, width: 18, height: 10, color: "#ffffff", text: "Apply", fontSize: 18, bold: true, align: "center" },
      { id: "s3-t3", kind: "text", x: 74, y: 43, width: 18, height: 10, color: "#ffffff", text: "Verify", fontSize: 18, bold: true, align: "center" },
    ],
  });

  return deck;
}

async function mountSlidesTab(token) {
  const deck = buildSampleDeck();
  const tools = createSlidesTools(deck);
  let showSvg = true;
  let aiSlideSeq = 1;

  stageEl.replaceChildren();
  const layout = el("div", { className: "slides-layout split-svg" });
  const gpuHost = el("div", { className: "slides-gpu-host", tabindex: "0" });
  const svgBox = el("div", { className: "slides-svg-box" });
  const svgSlideLabel = el("span", { textContent: "Slide 1" });
  const svgPane = el("div", { className: "slides-svg-pane" }, [
    el("div", { className: "slides-svg-head" }, [
      el("span", { textContent: "Deterministic SVG Preview" }),
      svgSlideLabel,
    ]),
    svgBox,
    el("p", {
      className: "hint-text",
      textContent: "Generated purely via Presentation.renderSvg() — compare pixel geometry side-by-side with the WebGPU/WebGL2 SDF stage.",
    }),
  ]);
  layout.appendChild(gpuHost);
  layout.appendChild(svgPane);
  stageEl.appendChild(layout);

  createDrawerShell(
    "Slides GPU Stage",
    "@jiange/slides-ui",
    "WebGPU/WebGL2 SDF stage + virtual thumbnail rail + deterministic SVG export & AI slide authoring.",
  );

  const prevBtn = el("button", { className: "btn btn-sm", textContent: "← Prev" });
  const slideCounter = el("span", { className: "pill", textContent: "1 / 3" });
  const nextBtn = el("button", { className: "btn btn-sm", textContent: "Next →" });
  const addSlideBtn = el("button", { className: "btn btn-primary", textContent: "AI slides_apply (+Slide)" });
  const verifyBtn = el("button", { className: "btn", textContent: "AI slides_verify" });
  const svgToggleBtn = el("button", { className: "btn btn-toggle active", textContent: "Side-by-Side SVG: ON" });
  const presenterBtn = el("button", { className: "btn btn-toggle", textContent: "Presenter Mode: OFF" });

  createCard("Deck Navigation & AI Tools", [
    el("div", { className: "btn-row", style: "align-items:center;" }, [prevBtn, slideCounter, nextBtn]),
    el("div", { className: "btn-row" }, [addSlideBtn, verifyBtn]),
    el("div", { className: "btn-row" }, [svgToggleBtn, presenterBtn]),
  ]);

  const { grid: metricsGrid, refs: m } = createMetricGrid([
    ["slidePos", "Active Slide", "1 / 3"],
    ["shapeCount", "Slide Shapes", "0"],
    ["selectedShape", "Selected Shape", "none"],
    ["gpuInst", "GPU Rect/Line/Arc", "—"],
  ]);
  createCard("Stage Telemetry", [metricsGrid]);

  const aiOut = createAiConsole();

  let mounted = null;
  let stopResize = null;

  function renderSvgPreview(idx) {
    const svgStr = deck.renderSvg(idx);
    const parsed = new DOMParser().parseFromString(svgStr, "image/svg+xml");
    if (parsed.documentElement && parsed.documentElement.nodeName.toLowerCase() === "svg") {
      svgBox.replaceChildren(parsed.documentElement);
    }
    svgSlideLabel.textContent = `Slide ${idx + 1} / ${deck.slideCount}`;
  }

  function highlightActiveThumb(idx) {
    const thumbs = gpuHost.querySelectorAll("[data-slide-index]");
    for (const t of thumbs) {
      t.classList.toggle("is-active-slide", Number(t.dataset.slideIndex) === idx);
    }
  }

  function syncUi(frame) {
    if (!mounted) return;
    const ctrl = mounted.controller;
    const idx = ctrl.getSlideIndex();
    const page = deck.getSlide(idx);
    const stats = frame?.gpu || ctrl.surface.stats || {
      backend: ctrl.surface.backendKind,
      drawCalls: 0,
      rectInstances: 0,
      lineInstances: 0,
      arcInstances: 0,
      glyphInstances: 0,
      frameTimeMs: 0,
    };

    slideCounter.textContent = `${idx + 1} / ${deck.slideCount}`;
    m.slidePos.textContent = `${idx + 1} / ${deck.slideCount}`;
    m.shapeCount.textContent = String(page?.shapes.length ?? 0);
    m.selectedShape.textContent = ctrl.getSelectedShapeId() || "none";
    m.gpuInst.textContent = `${stats.rectInstances}r / ${stats.lineInstances}l / ${stats.arcInstances}a`;

    highlightActiveThumb(idx);
    if (showSvg) renderSvgPreview(idx);

    updateTelemetry(stats, {
      slideIndex: idx,
      slideCount: deck.slideCount,
      slideTitle: page?.title ?? "",
      shapeCount: page?.shapes.length ?? 0,
      selectedShapeId: ctrl.getSelectedShapeId(),
      showSvg,
    });
  }

  const view = await mountSlidesView(gpuHost, deck, {
    onSlideChange: () => syncUi(),
    onSelectShape: () => syncUi(),
  });
  if (token !== mountToken) {
    view.dispose();
    return null;
  }
  mounted = view;

  const onThumbClick = (ev) => {
    const item = ev.target?.closest?.("[data-slide-index]");
    if (!item || !mounted) return;
    const idx = Number(item.dataset.slideIndex);
    if (Number.isInteger(idx)) {
      const frame = mounted.controller.goToSlide(idx);
      syncUi(frame);
    }
  };
  gpuHost.addEventListener("click", onThumbClick);

  function addSlideViaAi() {
    const n = aiSlideSeq++;
    const palette = ["#3370ff", "#00b42a", "#ff7d00", "#722ed1"];
    const accent = palette[(n - 1) % palette.length];
    const res = tools.execute("slides_apply", {
      actor: "ai-playground",
      ops: [
        {
          op: "addSlide",
          slide: {
            title: `AI Generated Slide #${n}`,
            background: "#f8faff",
            layout: "blank",
            shapes: [
              { id: `ai-${n}-bar`, kind: "rounded-rectangle", x: 6, y: 8, width: 88, height: 14, color: accent },
              { id: `ai-${n}-title`, kind: "text", x: 9, y: 11, width: 82, height: 8, color: "#ffffff", text: `AI Generated Slide #${n}`, fontSize: 24, bold: true },
              {
                id: `ai-${n}-chart`,
                kind: "chart",
                x: 6,
                y: 28,
                width: 52,
                height: 58,
                color: accent,
                chart: {
                  type: "column",
                  categories: ["Q1", "Q2", "Q3", "Q4"],
                  series: [{ name: "Growth", values: [35 + n * 5, 52 + n * 4, 71 + n * 3, 94], color: accent }],
                },
              },
              { id: `ai-${n}-orb`, kind: "ellipse", x: 68, y: 32, width: 20, height: 34, color: accent, opacity: 0.22 },
              { id: `ai-${n}-badge`, kind: "rounded-rectangle", x: 63, y: 72, width: 31, height: 14, color: "#eef3ff" },
              { id: `ai-${n}-txt`, kind: "text", x: 65, y: 75, width: 27, height: 8, color: "#1f2329", text: "Applied via slides_apply", fontSize: 13, align: "center" },
            ],
          },
        },
      ],
    });
    const frame = mounted.controller.goToSlide(deck.slideCount - 1);
    syncUi(frame);
    aiOut.set("slides_apply (+Slide)", res);
    return res;
  }

  function runVerify() {
    const res = tools.execute("slides_verify");
    aiOut.set("slides_verify", { diagnosticCount: res.length, diagnostics: res });
    return res;
  }

  prevBtn.addEventListener("click", () => syncUi(mounted.controller.prevSlide()));
  nextBtn.addEventListener("click", () => syncUi(mounted.controller.nextSlide()));
  addSlideBtn.addEventListener("click", addSlideViaAi);
  verifyBtn.addEventListener("click", runVerify);

  svgToggleBtn.addEventListener("click", () => {
    showSvg = !showSvg;
    svgToggleBtn.classList.toggle("active", showSvg);
    svgToggleBtn.textContent = showSvg ? "Side-by-Side SVG: ON" : "Side-by-Side SVG: OFF";
    layout.classList.toggle("split-svg", showSvg);
    svgPane.style.display = showSvg ? "" : "none";
    mounted.resize(gpuHost.clientWidth || 640, gpuHost.clientHeight || 520);
    syncUi(mounted.controller.render());
  });

  presenterBtn.addEventListener("click", () => {
    const next = !mounted.controller.isPresenterMode();
    presenterBtn.classList.toggle("active", next);
    presenterBtn.textContent = next ? "Presenter Mode: ON" : "Presenter Mode: OFF";
    syncUi(mounted.controller.setPresenterMode(next));
  });

  mounted.resize(gpuHost.clientWidth || 640, gpuHost.clientHeight || 520);
  syncUi(mounted.controller.render());

  stopResize = observeResize(gpuHost, (w, h) => {
    mounted?.resize(w, h);
    syncUi();
  });

  return {
    runAction(name, payload) {
      if (name === "addSlide") return addSlideViaAi();
      if (name === "verify") return runVerify();
      if (name === "goToSlide") {
        const frame = mounted.controller.goToSlide(Number(payload ?? 0));
        syncUi(frame);
        return state.tabMetrics;
      }
      return null;
    },
    dispose() {
      stopResize?.();
      gpuHost.removeEventListener("click", onThumbClick);
      mounted?.dispose();
      mounted = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Tab 4: Whiteboard (GPU Canvas)
// ---------------------------------------------------------------------------

const DEFAULT_MERMAID_ARCH = `flowchart LR
  User([Browser / AI Agent]) --> SDK[Jiange Domain SDKs]
  SDK --> Tools[AI Tool Facades]
  SDK --> GPU[render-gpu Engine]
  GPU --> WebGPU((WebGPU Primary))
  GPU -.fallback.-> WebGL2((WebGL2 SDF))
  WebGPU --> Sheet[sheet-ui]
  WebGPU --> Slides[slides-ui]
  WebGPU --> Board[whiteboard-ui]
  WebGPU --> Base[base-ui]
`;

async function mountWhiteboardTab(token) {
  let board = null;
  let tools = null;
  let mounted = null;
  let stopResize = null;
  let dragging = false;
  let lastDragX = 0;
  let lastDragY = 0;

  stageEl.replaceChildren();
  const host = el("div", { className: "stage-mount whiteboard-stage-wrap", tabindex: "0" });
  stageEl.appendChild(host);

  createDrawerShell(
    "Infinite Whiteboard",
    "@jiange/whiteboard-ui",
    "SpatialIndex frustum culling + Camera2D pan/zoom + WebGPU/WebGL2 SDF nodes, dashed edges & mind maps.",
  );

  const mermaidInput = el("textarea", { className: "code-textarea" });
  mermaidInput.value = DEFAULT_MERMAID_ARCH;
  const loadMermaidBtn = el("button", { className: "btn btn-primary", textContent: "Load Mermaid Architecture" });
  const layoutLrBtn = el("button", { className: "btn", textContent: "autoLayout (LR)" });
  const layoutTbBtn = el("button", { className: "btn", textContent: "autoLayout (TB)" });
  const verifyBtn = el("button", { className: "btn", textContent: "AI board_verify" });

  createCard("Mermaid & Layout Controls", [
    mermaidInput,
    el("div", { className: "btn-row" }, [loadMermaidBtn, verifyBtn]),
    el("div", { className: "btn-row" }, [layoutLrBtn, layoutTbBtn]),
  ]);

  const zoomInBtn = el("button", { className: "btn btn-sm", textContent: "Zoom +" });
  const zoomOutBtn = el("button", { className: "btn btn-sm", textContent: "Zoom -" });
  const fitBtn = el("button", { className: "btn btn-sm", textContent: "Fit Screen" });
  const panLeftBtn = el("button", { className: "btn btn-sm", textContent: "← Pan" });
  const panRightBtn = el("button", { className: "btn btn-sm", textContent: "Pan →" });

  createCard("Camera2D Navigation", [
    el("div", { className: "btn-row" }, [zoomInBtn, zoomOutBtn, fitBtn, panLeftBtn, panRightBtn]),
    el("p", {
      className: "hint-text",
      textContent: "Drag any node to reposition freely; drag empty canvas or wheel to pan; Ctrl/Cmd + wheel to zoom.",
    }),
  ]);

  const { grid: metricsGrid, refs: m } = createMetricGrid([
    ["nodes", "Visible / Total Nodes", "0 / 0"],
    ["edges", "Edges", "0"],
    ["zoom", "Camera Zoom", "100%"],
    ["gpuInst", "GPU Rect/Line/Arc", "—"],
  ]);
  createCard("Canvas Telemetry", [metricsGrid]);

  const aiOut = createAiConsole();

  function syncUi(frame) {
    if (!mounted || !board) return;
    const ctrl = mounted.controller;
    const g = board.toGraph();
    const stats = frame?.gpu || ctrl.surface.stats || {
      backend: ctrl.surface.backendKind,
      drawCalls: 0,
      rectInstances: 0,
      lineInstances: 0,
      arcInstances: 0,
      glyphInstances: 0,
      frameTimeMs: 0,
    };
    const visNodes = frame?.visibleNodes ?? g.nodes.length;
    const zoomPct = Math.round((frame?.zoom ?? ctrl.camera.zoom) * 100);

    m.nodes.textContent = `${visNodes} / ${g.nodes.length}`;
    m.edges.textContent = String(g.edges.length);
    m.zoom.textContent = `${zoomPct}%`;
    m.gpuInst.textContent = `${stats.rectInstances}r / ${stats.lineInstances}l / ${stats.arcInstances}a`;

    updateTelemetry(stats, {
      visibleNodes: visNodes,
      totalNodes: g.nodes.length,
      edgeCount: g.edges.length,
      zoom: Number((frame?.zoom ?? ctrl.camera.zoom).toFixed(2)),
    });
  }

  async function loadMermaid(code) {
    if (mounted) {
      mounted.dispose();
      mounted = null;
    }
    board = Board.fromMermaid(code, { direction: "LR" });
    board.autoLayout({ direction: "LR", gapX: 72, gapY: 44 });
    tools = createWhiteboardTools(board);

    const view = await mountWhiteboardView(host, board, {
      onSelectionChange: () => syncUi(),
    });
    if (token !== mountToken) {
      view.dispose();
      return;
    }
    mounted = view;
    mounted.resize(host.clientWidth || 860, host.clientHeight || 560);
    const frame = mounted.controller.fitToScreen(56);
    syncUi(frame);
  }

  function runAutoLayout(direction = "LR") {
    if (!board || !mounted) return null;
    board.autoLayout({ direction, gapX: 72, gapY: 48 });
    const frame = mounted.controller.fitToScreen(56);
    syncUi(frame);
    aiOut.set(`autoLayout (${direction})`, {
      direction,
      nodeCount: board.toGraph().nodes.length,
      edgeCount: board.toGraph().edges.length,
    });
    return frame;
  }

  function runVerify() {
    if (!tools) return null;
    const diagnostics = tools.execute("board_verify");
    aiOut.set("board_verify", {
      ok: diagnostics.every((d) => d.severity !== "error"),
      diagnosticCount: diagnostics.length,
      diagnostics,
    });
    return diagnostics;
  }

  // Telemetry & cursor sync (actual node dragging and canvas panning are handled natively by mountWhiteboardView)
  const onPointerDown = (e) => {
    if (!mounted || e.button !== 0) return;
    dragging = true;
    host.classList.add("dragging");
  };
  const onPointerMove = () => {
    if (!dragging || !mounted) return;
    syncUi();
  };
  const onPointerUp = () => {
    if (dragging) {
      dragging = false;
      host.classList.remove("dragging");
      if (mounted) syncUi();
    }
  };
  const onWheelSync = () => {
    if (mounted) syncUi();
  };

  host.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  host.addEventListener("wheel", onWheelSync, { passive: true });

  loadMermaidBtn.addEventListener("click", () => {
    void loadMermaid(mermaidInput.value).then(() => {
      aiOut.set("Board.fromMermaid()", {
        nodes: board.toGraph().nodes.length,
        edges: board.toGraph().edges.length,
      });
    });
  });
  layoutLrBtn.addEventListener("click", () => runAutoLayout("LR"));
  layoutTbBtn.addEventListener("click", () => runAutoLayout("TB"));
  verifyBtn.addEventListener("click", runVerify);

  zoomInBtn.addEventListener("click", () => {
    if (!mounted) return;
    syncUi(mounted.controller.zoomAt(1.2, (host.clientWidth || 800) / 2, (host.clientHeight || 540) / 2));
  });
  zoomOutBtn.addEventListener("click", () => {
    if (!mounted) return;
    syncUi(mounted.controller.zoomAt(0.82, (host.clientWidth || 800) / 2, (host.clientHeight || 540) / 2));
  });
  fitBtn.addEventListener("click", () => {
    if (mounted) syncUi(mounted.controller.fitToScreen(56));
  });
  panLeftBtn.addEventListener("click", () => {
    if (mounted) syncUi(mounted.controller.pan(80, 0));
  });
  panRightBtn.addEventListener("click", () => {
    if (mounted) syncUi(mounted.controller.pan(-80, 0));
  });

  await loadMermaid(DEFAULT_MERMAID_ARCH);
  if (token !== mountToken) return null;

  stopResize = observeResize(host, (w, h) => {
    mounted?.resize(w, h);
    syncUi();
  });

  return {
    async runAction(name, payload) {
      if (name === "loadMermaid") {
        await loadMermaid(typeof payload === "string" ? payload : mermaidInput.value);
        return state.tabMetrics;
      }
      if (name === "autoLayout") return runAutoLayout(payload === "TB" ? "TB" : "LR");
      if (name === "verify") return runVerify();
      if (name === "zoomIn" && mounted) {
        const f = mounted.controller.zoomAt(1.2, 400, 300);
        syncUi(f);
        return state.tabMetrics;
      }
      return null;
    },
    dispose() {
      stopResize?.();
      host.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      host.removeEventListener("wheel", onWheelSync);
      mounted?.dispose();
      mounted = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Tab 5: Base (Grid / Kanban / Gantt / Dashboard)
// ---------------------------------------------------------------------------

function buildBaseDataset(recordCount) {
  const stages = ["Backlog", "In Progress", "Review", "Done"];
  const teams = ["Core GPU", "AI SDK", "Sheets", "Docs"];
  const items = [
    "WebGPU SDF Rect Pipeline",
    "R8 Procedural GlyphAtlas",
    "4-Quadrant Frozen Grid",
    "Incremental Formula DAG",
    "Mermaid Layered Layout",
    "Deterministic SVG Stage",
    "CRDT Undo Checkpoints",
    "OOXML Streaming Export",
  ];
  const now = new Date().toISOString();
  const records = [];
  for (let i = 1; i <= recordCount; i++) {
    const day = String(((i * 3) % 28) + 1).padStart(2, "0");
    const month = String((i % 12) + 1).padStart(2, "0");
    records.push({
      id: i,
      baseId: 1,
      tableId: 1,
      position: i * 1000,
      createdAt: now,
      updatedAt: now,
      cells: {
        "1": recordCount > 100 ? `Task #${String(i).padStart(5, "0")} · ${items[i % items.length]}` : `${items[i % items.length]} #${i}`,
        "2": stages[i % stages.length],
        "3": teams[i % teams.length],
        "4": 40 + ((i * 17) % 60),
        "5": 2500 + ((i * 733) % 42000),
        "6": `2026-${month}-${day}`,
      },
    });
  }

  return Base.fromJSON({
    name: recordCount >= 10000 ? "Jiange Enterprise Base (10K)" : "Jiange Product Roadmap",
    tables: [{ id: 1, baseId: 1, name: "Milestones", position: 1000, isDefault: true }],
    fields: [
      { id: 1, tableId: 1, name: "Milestone", type: "text", isPrimary: true, position: 1000 },
      { id: 2, tableId: 1, name: "Stage", type: "select", options: stages, position: 2000 },
      { id: 3, tableId: 1, name: "Team", type: "select", options: teams, position: 3000 },
      { id: 4, tableId: 1, name: "Progress %", type: "number", position: 4000 },
      { id: 5, tableId: 1, name: "Budget ($)", type: "number", position: 5000 },
      { id: 6, tableId: 1, name: "Target Date", type: "date", position: 6000 },
    ],
    records,
    views: [{ id: 1, baseId: 1, tableId: 1, type: "grid", name: "All Milestones", config: {}, pos: 1000 }],
  });
}

async function mountBaseTab(token) {
  let currentMode = "grid";
  let stressMode = false;
  let baseModel = null;
  let tools = null;
  let mounted = null;
  let stopResize = null;
  let buildMs = 0;
  let gridScrollLeft = 0;

  stageEl.replaceChildren();
  const wrapper = el("div", { className: "stage-mount base-stage-wrap" });
  const mountHost = el("div", { className: "stage-mount" });
  const headerOverlay = el("div", { className: "base-col-headers" });
  wrapper.appendChild(mountHost);
  wrapper.appendChild(headerOverlay);
  stageEl.appendChild(wrapper);

  createDrawerShell(
    "Multidimensional Base",
    "@jiange/base-ui",
    "Unified GPU Grid, Kanban, Gantt & Dashboard renderer over @jiange/base-sdk with 10k-record virtualization.",
  );

  const modes = [
    ["grid", "Grid"],
    ["kanban", "Kanban"],
    ["gantt", "Gantt"],
    ["dashboard", "Dashboard"],
  ];
  const modeBtns = new Map();
  const segmented = el("div", { className: "segmented" });
  for (const [id, label] of modes) {
    const btn = el("button", {
      className: `btn${id === currentMode ? " active" : ""}`,
      textContent: label,
      dataset: { baseMode: id },
      onClick: () => switchMode(id),
    });
    modeBtns.set(id, btn);
    segmented.appendChild(btn);
  }

  const stressBtn = el("button", { className: "btn btn-toggle", textContent: "10,000 Records Stress: OFF" });
  const inspectBtn = el("button", { className: "btn btn-primary", textContent: "AI base_inspect" });
  const verifyBtn = el("button", { className: "btn", textContent: "AI base_verify" });

  createCard("GPU View Mode & Stress", [
    segmented,
    el("div", { className: "btn-row" }, [stressBtn]),
    el("div", { className: "btn-row" }, [inspectBtn, verifyBtn]),
  ]);

  const { grid: metricsGrid, refs: m } = createMetricGrid([
    ["mode", "Active Mode", "grid"],
    ["records", "Records", "0"],
    ["mounted", "Mounted Pool", "0"],
    ["gpuInst", "GPU Rect/Line/Arc", "—"],
  ]);
  createCard("Base GPU Telemetry", [metricsGrid]);

  const aiOut = createAiConsole();

  function renderHeaderOverlay() {
    headerOverlay.style.display = currentMode === "grid" ? "flex" : "none";
    if (!baseModel || currentMode !== "grid") return;
    const fields = baseModel.getFields();
    headerOverlay.replaceChildren(
      ...fields.map((f, idx) => {
        const cell = el("div", { className: "base-col-header-cell", textContent: f.name });
        if (idx === 0) {
          cell.style.position = "sticky";
          cell.style.left = "0";
          cell.style.zIndex = "2";
          cell.style.background = "#f5f7fb";
        } else {
          cell.style.transform = `translate3d(${-gridScrollLeft}px, 0, 0)`;
        }
        return cell;
      }),
    );
  }

  function syncUi(frame) {
    if (!mounted || !baseModel) return;
    const ctrl = mounted.controller;
    const stats = frame?.gpu || ctrl.surface.stats || {
      backend: ctrl.surface.backendKind,
      drawCalls: 0,
      rectInstances: 0,
      lineInstances: 0,
      arcInstances: 0,
      glyphInstances: 0,
      frameTimeMs: 0,
    };
    const recordCount = frame?.recordCount ?? baseModel.getRecords(undefined, { computed: false }).length;
    const mountedEls = frame?.mountedElements ?? ctrl.grid.pool.activeCount;

    m.mode.textContent = currentMode;
    m.records.textContent = recordCount.toLocaleString();
    m.mounted.textContent = String(mountedEls);
    m.gpuInst.textContent = `${stats.rectInstances}r / ${stats.lineInstances}l / ${stats.arcInstances}a`;

    renderHeaderOverlay();
    updateTelemetry(stats, {
      mode: currentMode,
      stressMode,
      recordCount,
      mountedElements: mountedEls,
      buildMs: Number(buildMs.toFixed(1)),
    });
  }

  async function mountBase(isStress) {
    if (mounted) {
      mounted.dispose();
      mounted = null;
    }
    const t0 = performance.now();
    baseModel = buildBaseDataset(isStress ? 10000 : 40);
    buildMs = performance.now() - t0;
    tools = createBaseTools(baseModel);

    const view = await mountBaseView(mountHost, baseModel, {
      mode: currentMode,
      frozenCols: 1,
      rowHeight: 34,
      colWidth: 160,
      fills: [
        { f: 2, op: "eq", v: "Done", color: 1 },
        { f: 2, op: "eq", v: "Review", color: 2 },
      ],
    });
    if (token !== mountToken) {
      view.dispose();
      return;
    }
    mounted = view;
    mounted.resize(mountHost.clientWidth || 860, mountHost.clientHeight || 560);
    const frame = mounted.controller.render();
    syncUi(frame);
  }

  function switchMode(mode) {
    currentMode = mode;
    gridScrollLeft = 0;
    for (const [id, btn] of modeBtns.entries()) {
      btn.classList.toggle("active", id === mode);
    }
    if (!mounted) return null;
    const frame = mounted.controller.setMode(mode);
    syncUi(frame);
    return state.tabMetrics;
  }

  async function toggleStress() {
    stressMode = !stressMode;
    gridScrollLeft = 0;
    stressBtn.classList.toggle("active", stressMode);
    stressBtn.textContent = stressMode ? "10,000 Records Stress: ON" : "10,000 Records Stress: OFF";
    await mountBase(stressMode);
    aiOut.set(
      stressMode ? "10,000-Record Base Mounted" : "Default 40-Record Base Restored",
      {
        mode: currentMode,
        records: stressMode ? 10000 : 40,
        buildTimeMs: Number(buildMs.toFixed(1)),
      },
    );
  }

  function runInspect() {
    if (!tools) return null;
    const res = tools.execute("base_inspect", { detail: "standard" });
    aiOut.set("base_inspect", res);
    return res;
  }

  function runVerify() {
    if (!tools) return null;
    const res = tools.execute("base_verify");
    aiOut.set("base_verify", { ok: res.length === 0, diagnostics: res });
    return res;
  }

  const onWheelSync = (e) => {
    if (currentMode === "grid") {
      gridScrollLeft = Math.max(0, gridScrollLeft + e.deltaX);
    }
    if (mounted) syncUi();
  };
  mountHost.addEventListener("wheel", onWheelSync, { passive: true });
  stressBtn.addEventListener("click", () => { void toggleStress(); });
  inspectBtn.addEventListener("click", runInspect);
  verifyBtn.addEventListener("click", runVerify);

  await mountBase(false);
  if (token !== mountToken) return null;

  stopResize = observeResize(mountHost, (w, h) => {
    mounted?.resize(w, h);
    syncUi();
  });

  return {
    async runAction(name, payload) {
      if (name === "setMode" && typeof payload === "string") return switchMode(payload);
      if (name === "toggleStress") { await toggleStress(); return state.tabMetrics; }
      if (name === "inspect") return runInspect();
      if (name === "verify") return runVerify();
      return null;
    },
    dispose() {
      stopResize?.();
      mountHost.removeEventListener("wheel", onWheelSync);
      mounted?.dispose();
      mounted = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Tab 6: GPU GlyphAtlas Lab (Direct GpuSurface + GlyphAtlas + InstanceBatch)
// ---------------------------------------------------------------------------

async function mountGlyphLabTab(token) {
  let preferBackend = "webgpu";
  let customText = "JIANGE WEBGPU + WEBGL2 // ZERO CANVAS 2D";
  let extraPrimitives = 64;
  let animating = false;
  let phase = 0;
  let rafId = null;

  let canvas = null;
  let atlas = null;
  let surface = null;
  let batch = new InstanceBatch(2048, 2048, 512, 4096);
  let stopResize = null;

  stageEl.replaceChildren();
  const wrap = el("div", { className: "stage-mount glyph-lab-wrap" });
  stageEl.appendChild(wrap);

  createDrawerShell(
    "GPU GlyphAtlas Lab",
    "@jiange/render-gpu",
    "Direct single-frame testbench for all 4 instanced pipelines: SDF Rect, Dashed Line, Pie/Donut Arc, and R8 GlyphAtlas.",
  );

  const textInput = el("input", {
    className: "text-input",
    type: "text",
    value: customText,
    placeholder: "Type ASCII text rendered directly on GPU...",
  });
  const countLabel = el("span", { textContent: String(extraPrimitives) });
  const countSlider = el("input", {
    className: "range-input",
    type: "range",
    min: "0",
    max: "1200",
    step: "32",
    value: String(extraPrimitives),
  });
  const backendSelect = el("select", { className: "select-input" }, [
    el("option", { value: "webgpu", textContent: "Auto (WebGPU -> WebGL2)" }),
    el("option", { value: "webgl2", textContent: "Force WebGL2 Fallback" }),
    el("option", { value: "headless", textContent: "HeadlessNullBackend (Zero GPU)" }),
  ]);
  const animBtn = el("button", { className: "btn btn-toggle", textContent: "Animate GPU Frame: OFF" });
  const rerenderBtn = el("button", { className: "btn btn-primary", textContent: "Render Frame" });

  createCard("Direct Pipeline Controls", [
    el("div", { className: "field-group" }, [
      el("label", { className: "field-label" }, [el("span", { textContent: "Live GPU pushText() String" })]),
      textInput,
    ]),
    el("div", { className: "field-group" }, [
      el("label", { className: "field-label" }, [
        el("span", { textContent: "Extra Instanced Primitives" }),
        countLabel,
      ]),
      countSlider,
    ]),
    el("div", { className: "field-group" }, [
      el("label", { className: "field-label" }, [el("span", { textContent: "Backend Preference" })]),
      backendSelect,
    ]),
    el("div", { className: "btn-row" }, [animBtn, rerenderBtn]),
  ]);

  const { grid: metricsGrid, refs: m } = createMetricGrid([
    ["backendKind", "backendKind", "—"],
    ["drawCalls", "drawCalls", "0"],
    ["rects", "rectInstances", "0"],
    ["lines", "lineInstances", "0"],
    ["arcs", "arcInstances", "0"],
    ["glyphs", "glyphInstances", "0"],
    ["atlasInfo", "R8 GlyphAtlas", "256×256"],
    ["frameMs", "frameTimeMs", "0.00 ms"],
  ]);
  createCard("Exact GpuFrameStats", [metricsGrid]);

  const aiOut = createAiConsole("Inspecting live GpuSurface + GlyphAtlas R8 texture upload...");

  function renderFrame() {
    if (!surface || !atlas) return null;
    const w = Math.max(360, wrap.clientWidth || 860);
    const h = Math.max(300, wrap.clientHeight || 560);
    batch.reset();

    // 1. Subtle coordinate grid via SDF lines
    const gridColor = packColorRGBA("#e6ecf5");
    for (let gx = 40; gx < w; gx += 40) {
      batch.pushLine({ x1: gx, y1: 0, x2: gx, y2: h, thickness: 1, color: gridColor });
    }
    for (let gy = 40; gy < h; gy += 40) {
      batch.pushLine({ x1: 0, y1: gy, x2: w, y2: gy, thickness: 1, color: gridColor });
    }

    // 2. Top Banner SDF Rounded Rect + R8 Bitmap Title
    const pad = 24;
    const bannerW = Math.max(260, w - pad * 2);
    batch.pushRect({
      x: pad,
      y: pad,
      w: bannerW,
      h: 76,
      fill: packColorRGBA("#ffffff"),
      radius: 12,
      borderWidth: 1.5,
      borderColor: packColorRGBA("#c5d7ff"),
    });
    batch.pushRect({
      x: pad + 14,
      y: pad + 16,
      w: 10,
      h: 44,
      fill: packColorRGBA("#3370ff"),
      radius: 5,
    });
    batch.pushText(
      atlas,
      customText || "JIANGE RENDER-GPU",
      pad + 36,
      pad + 18,
      16,
      packColorRGBA("#1f2329"),
    );
    batch.pushText(
      atlas,
      `BACKEND: ${surface.backendKind.toUpperCase()}  |  PIPELINE: 4 INSTANCED PASSES  |  ZERO CANVAS 2D`,
      pad + 36,
      pad + 46,
      11,
      packColorRGBA("#3370ff"),
    );

    // 3. Four Pipeline Showcase Cards
    const topY = pad + 94;
    const colGap = 16;
    const cardW = Math.max(150, (bannerW - colGap) / 2);
    const cardH = Math.max(148, Math.min(200, (h - topY - pad - colGap) / 2));

    const cards = [
      { x: pad, y: topY, title: "1. SDF ROUNDED RECTS", accent: "#3370ff" },
      { x: pad + cardW + colGap, y: topY, title: "2. DASHED & SOLID LINES", accent: "#722ed1" },
      { x: pad, y: topY + cardH + colGap, title: "3. PIE & DONUT ARCS", accent: "#00b42a" },
      { x: pad + cardW + colGap, y: topY + cardH + colGap, title: "4. R8 BITMAP GLYPH ATLAS", accent: "#ff7d00" },
    ];

    for (const c of cards) {
      batch.pushRect({
        x: c.x,
        y: c.y,
        w: cardW,
        h: cardH,
        fill: packColorRGBA("#ffffff"),
        radius: 10,
        borderWidth: 1,
        borderColor: packColorRGBA("#dde4f0"),
      });
      batch.pushRect({
        x: c.x,
        y: c.y,
        w: cardW,
        h: 30,
        fill: packColorRGBA("#f5f8ff"),
        radius: 10,
      });
      batch.pushText(atlas, c.title, c.x + 14, c.y + 10, 11, packColorRGBA(c.accent));
    }

    // Card 1 content: SDF rounded rects + rotated pill + stress chips
    const c1 = cards[0];
    const swatchColors = ["#3370ff", "#00b42a", "#ff7d00", "#722ed1"];
    swatchColors.forEach((hex, idx) => {
      batch.pushRect({
        x: c1.x + 18 + idx * 46,
        y: c1.y + 46,
        w: 36,
        h: 36,
        fill: packColorRGBA(hex),
        radius: 4 + idx * 4,
        borderWidth: 1.5,
        borderColor: packColorRGBA("#ffffff"),
        rotationRad: idx === 3 ? phase : 0,
      });
    });
    batch.pushRect({
      x: c1.x + 18,
      y: c1.y + 96,
      w: Math.max(100, cardW - 36),
      h: 32,
      fill: packColorRGBA("#eef3ff"),
      radius: 16,
      borderWidth: 2,
      borderColor: packColorRGBA("#3370ff"),
    });
    batch.pushText(atlas, "ANTI-ALIASED SDF BORDERS", c1.x + 32, c1.y + 107, 10, packColorRGBA("#3370ff"));

    // Card 2 content: solid + dashed lines + animated wave
    const c2 = cards[1];
    batch.pushLine({
      x1: c2.x + 20,
      y1: c2.y + 52,
      x2: c2.x + cardW - 20,
      y2: c2.y + 52,
      thickness: 3,
      color: packColorRGBA("#3370ff"),
      dashLen: 10,
      gapLen: 6,
    });
    batch.pushLine({
      x1: c2.x + 20,
      y1: c2.y + 72,
      x2: c2.x + cardW - 20,
      y2: c2.y + 72,
      thickness: 2.5,
      color: packColorRGBA("#722ed1"),
      dashLen: 5,
      gapLen: 4,
    });
    const pts = 18;
    const spanW = Math.max(80, cardW - 40);
    for (let i = 0; i < pts; i++) {
      const t1 = i / pts;
      const t2 = (i + 1) / pts;
      const x1 = c2.x + 20 + t1 * spanW;
      const x2 = c2.x + 20 + t2 * spanW;
      const y1 = c2.y + 114 + Math.sin(t1 * Math.PI * 3 + phase * 2) * 18;
      const y2 = c2.y + 114 + Math.sin(t2 * Math.PI * 3 + phase * 2) * 18;
      batch.pushLine({ x1, y1, x2, y2, thickness: 2.5, color: packColorRGBA("#00b42a") });
    }

    // Card 3 content: multi-segment donut + solid pie arcs
    const c3 = cards[2];
    const donutR = Math.min(46, (cardH - 52) / 2);
    const donutCx = c3.x + cardW * 0.32;
    const donutCy = c3.y + 34 + (cardH - 40) / 2;
    const slices = [
      { sweep: 0.38, color: "#3370ff" },
      { sweep: 0.27, color: "#00b42a" },
      { sweep: 0.2, color: "#ff7d00" },
      { sweep: 0.15, color: "#722ed1" },
    ];
    let ang = phase * 0.7;
    for (const sl of slices) {
      const nextAng = ang + sl.sweep * Math.PI * 2;
      batch.pushArc({
        cx: donutCx,
        cy: donutCy,
        rx: donutR,
        ry: donutR,
        innerRatio: 0.56,
        startAngle: ang,
        endAngle: nextAng,
        color: packColorRGBA(sl.color),
      });
      ang = nextAng;
    }
    const pieCx = c3.x + cardW * 0.74;
    batch.pushArc({
      cx: pieCx,
      cy: donutCy,
      rx: donutR * 0.85,
      ry: donutR * 0.85,
      innerRatio: 0,
      startAngle: 0,
      endAngle: Math.PI * 1.45,
      color: packColorRGBA("#3370ff", 0.85),
    });
    batch.pushArc({
      cx: pieCx,
      cy: donutCy,
      rx: donutR * 0.85,
      ry: donutR * 0.85,
      innerRatio: 0,
      startAngle: Math.PI * 1.45,
      endAngle: Math.PI * 2,
      color: packColorRGBA("#ff7d00", 0.88),
    });

    // Card 4 content: R8 Bitmap GlyphAtlas multi-size text + fallback box demo
    const c4 = cards[3];
    batch.pushText(atlas, "PROCEDURAL 5x7 R8 FONT", c4.x + 16, c4.y + 44, 14, packColorRGBA("#1f2329"));
    batch.pushText(atlas, "0123456789 +-*/=()[]{}", c4.x + 16, c4.y + 68, 12, packColorRGBA("#3370ff"));
    batch.pushText(atlas, "PACKED TO r8unorm / GL_R8", c4.x + 16, c4.y + 90, 11, packColorRGBA("#00b42a"));
    batch.pushText(atlas, "FALLBACK CJK: 剑阁 GPU", c4.x + 16, c4.y + 112, 11, packColorRGBA("#ff7d00"));

    // 4. Optional Extra Instanced Primitives bar along the bottom to prove O(1) draw calls
    const extraCount = extraPrimitives;
    if (extraCount > 0) {
      const stripY = Math.min(h - 20, topY + cardH * 2 + colGap + 8);
      const step = bannerW / Math.max(1, extraCount);
      for (let i = 0; i < extraCount; i++) {
        const px = pad + i * step;
        const barH = 4 + ((i * 13) % 10);
        batch.pushRect({
          x: px,
          y: stripY + (12 - barH),
          w: Math.max(1.5, step - 1),
          h: barH,
          fill: packColorRGBA(swatchColors[i % swatchColors.length], 0.72),
          radius: 1,
        });
      }
    }

    const stats = surface.render([batch]);

    m.backendKind.textContent = surface.backendKind;
    m.drawCalls.textContent = String(stats.drawCalls);
    m.rects.textContent = String(stats.rectInstances);
    m.lines.textContent = String(stats.lineInstances);
    m.arcs.textContent = String(stats.arcInstances);
    m.glyphs.textContent = String(stats.glyphInstances);
    m.atlasInfo.textContent = `${atlas.glyphCount} glyphs (${atlas.width}×${atlas.height} R8)`;
    m.frameMs.textContent = `${stats.frameTimeMs.toFixed(2)} ms`;

    const summary = {
      backendKind: surface.backendKind,
      drawCalls: stats.drawCalls,
      rectInstances: stats.rectInstances,
      lineInstances: stats.lineInstances,
      arcInstances: stats.arcInstances,
      glyphInstances: stats.glyphInstances,
      atlasGlyphCount: atlas.glyphCount,
      atlasDimensions: `${atlas.width}x${atlas.height}`,
      frameTimeMs: Number(stats.frameTimeMs.toFixed(3)),
    };
    aiOut.set("GpuSurface.render([batch])", summary);
    updateTelemetry(stats, summary);
    return stats;
  }

  async function initSurface(prefer) {
    if (surface) {
      surface.dispose();
      surface = null;
    }
    wrap.replaceChildren();
    canvas = el("canvas", { className: "glyph-lab-canvas" });
    wrap.appendChild(canvas);

    atlas = new GlyphAtlas({ width: 256, height: 256, padding: 1 });
    const nextSurface = await GpuSurface.create(canvas, {
      prefer,
      glyphAtlas: atlas,
      clearColor: [0.972, 0.98, 0.996, 1],
    });
    if (token !== mountToken) {
      nextSurface.dispose();
      return;
    }
    surface = nextSurface;
    surface.resize(wrap.clientWidth || 860, wrap.clientHeight || 560);
    renderFrame();
  }

  function tickAnimation() {
    if (!animating || token !== mountToken) {
      rafId = null;
      return;
    }
    phase += 0.025;
    renderFrame();
    rafId = requestAnimationFrame(tickAnimation);
  }

  function toggleAnimation() {
    animating = !animating;
    animBtn.classList.toggle("active", animating);
    animBtn.textContent = animating ? "Animate GPU Frame: ON" : "Animate GPU Frame: OFF";
    if (animating && rafId === null) {
      rafId = requestAnimationFrame(tickAnimation);
    } else if (!animating && rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  textInput.addEventListener("input", () => {
    customText = textInput.value;
    renderFrame();
  });
  countSlider.addEventListener("input", () => {
    extraPrimitives = Number(countSlider.value);
    countLabel.textContent = String(extraPrimitives);
    renderFrame();
  });
  backendSelect.addEventListener("change", () => {
    preferBackend = backendSelect.value;
    void initSurface(preferBackend);
  });
  animBtn.addEventListener("click", toggleAnimation);
  rerenderBtn.addEventListener("click", renderFrame);

  await initSurface(preferBackend);
  if (token !== mountToken) return null;

  stopResize = observeResize(wrap, (w, h) => {
    if (!surface) return;
    surface.resize(w, h);
    renderFrame();
  });

  return {
    async runAction(name, payload) {
      if (name === "setText") {
        customText = String(payload || "");
        textInput.value = customText;
        return renderFrame();
      }
      if (name === "setBackend") {
        preferBackend = String(payload || "webgpu");
        backendSelect.value = preferBackend;
        await initSurface(preferBackend);
        return state.tabMetrics;
      }
      if (name === "render") return renderFrame();
      return null;
    },
    dispose() {
      animating = false;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      stopResize?.();
      surface?.dispose();
      surface = null;
      atlas = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Tab Router & Debug Hook
// ---------------------------------------------------------------------------

const TAB_MOUNTERS = {
  sheet: mountSheetTab,
  doc: mountDocTab,
  slides: mountSlidesTab,
  whiteboard: mountWhiteboardTab,
  base: mountBaseTab,
  "glyph-lab": mountGlyphLabTab,
};

async function switchTab(tabId) {
  if (!TAB_MOUNTERS[tabId]) {
    throw new Error(`Unknown playground tab: ${tabId}`);
  }
  const token = ++mountToken;

  if (activeSession) {
    activeSession.dispose();
    activeSession = null;
  }

  state.activeTab = tabId;
  for (const btn of tabButtons) {
    const isActive = btn.dataset.tab === tabId;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", String(isActive));
  }

  const session = await TAB_MOUNTERS[tabId](token);
  if (token !== mountToken) {
    session?.dispose();
    return;
  }
  activeSession = session;
}

for (const btn of tabButtons) {
  btn.addEventListener("click", () => {
    const target = btn.dataset.tab;
    if (target) void switchTab(target);
  });
}

window.__JIANGE_PLAYGROUND__ = {
  get activeTab() {
    return state.activeTab;
  },
  switchTab,
  getState() {
    return {
      activeTab: state.activeTab,
      backend: state.backend,
      stats: { ...state.stats },
      tabMetrics: { ...state.tabMetrics },
      lastAiResult: state.lastAiResult,
      zeroCanvas2D: true,
      errors: [...state.errors],
    };
  },
  async runAction(name, payload) {
    if (!activeSession || typeof activeSession.runAction !== "function") {
      return null;
    }
    return activeSession.runAction(name, payload);
  },
};

// Boot default tab
void switchTab("sheet");
