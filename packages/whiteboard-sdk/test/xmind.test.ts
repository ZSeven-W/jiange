import { describe, expect, it } from "vitest";
import { createZip, listZip } from "@jiange/ooxml/zip";
import { exportMindMapToXmind, parseXmindToMindMap, XmindError } from "../src/xmind.js";
import type { FlowGraph } from "../src/model.js";

describe("whiteboard-sdk .xmind export and import", () => {
  it("round-trips multi-sheet mind map with hierarchy, descriptions, folded state, paints, and text formatting", async () => {
    const graph: FlowGraph = {
      theme: "feishu",
      nodes: [],
      edges: [],
      mind: [
        { id: "r1", parent: null, order: 1000, text: "2026 产品路线图", x: 160, y: 200 },
        { id: "c1", parent: "r1", order: 1000, text: "协同引擎" },
        { id: "c1a", parent: "c1", order: 1000, text: "CRDT 压缩" },
        { id: "c2", parent: "r1", order: 2000, text: "多端生态" },
        { id: "r2", parent: null, order: 2000, text: "备选架构方案", x: 160, y: 500 },
        { id: "c3", parent: "r2", order: 1000, text: "离线优先" },
      ],
      mindCollapsed: ["c1"],
      mindDescriptions: {
        r1: "年度总目标与关键交付节奏",
        c1a: "确保全员安全水位再执行 GC",
      },
      mindStyles: {
        r1: { shape: "rect", size: 24, color: "#ffffff" },
        c1: { shape: "oval", size: 16, color: "#1f2329" },
        c2: { shape: "text", size: 14 },
      },
      mindPaints: {
        r1: { fill: "#3370ff", stroke: "#1f2329", width: 3 },
        c1: { fill: "#dff2dd", stroke: "#2ea121", width: 2 },
      },
      mindTextFormats: {
        r1: { bold: true, align: "center" },
        c1a: { italic: true, underline: true },
        c2: { strike: true },
      },
    };

    const bytes = exportMindMapToXmind(graph, { title: "路线图" });
    const names = listZip(bytes).map((e) => e.name);
    expect(names).toContain("content.json");
    expect(names).toContain("metadata.json");
    expect(names).toContain("manifest.json");
    expect(names).toContain("META-INF/manifest.xml");

    const parsed = await parseXmindToMindMap(bytes);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.sheetCount).toBe(2);
    expect(parsed.topicCount).toBe(6);

    const roots = parsed.mind.filter((t) => t.parent === null);
    expect(roots.map((r) => r.text)).toEqual(["2026 产品路线图", "备选架构方案"]);
    const root1 = roots[0];
    expect(parsed.mindDescriptions[root1.id]).toBe("年度总目标与关键交付节奏");
    expect(parsed.mindStyles[root1.id]).toEqual({ shape: "rect", size: 24, color: "#ffffff" });
    expect(parsed.mindPaints[root1.id]).toEqual({ fill: "#3370ff", stroke: "#1f2329", width: 3 });
    expect(parsed.mindTextFormats[root1.id]).toEqual({ bold: true, align: "center" });

    const childrenOfRoot1 = parsed.mind.filter((t) => t.parent === root1.id);
    expect(childrenOfRoot1.map((c) => c.text)).toEqual(["协同引擎", "多端生态"]);
    const c1 = childrenOfRoot1[0];
    expect(parsed.mindCollapsed).toContain(c1.id);
    expect(parsed.mindStyles[c1.id]).toEqual({ shape: "oval", size: 16, color: "#1f2329" });
    expect(parsed.mindPaints[c1.id]).toEqual({ fill: "#dff2dd", stroke: "#2ea121", width: 2 });

    const c1a = parsed.mind.find((t) => t.parent === c1.id)!;
    expect(c1a.text).toBe("CRDT 压缩");
    expect(parsed.mindDescriptions[c1a.id]).toBe("确保全员安全水位再执行 GC");
    expect(parsed.mindTextFormats[c1a.id]).toEqual({ italic: true, underline: true });
  });

  it("imports legacy XMind 8 content.xml archives cleanly", async () => {
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<xmap-content version="2.0">` +
      `<sheet id="s1"><topic id="t1"><title>XMind 8 根节点</title>` +
      `<notes><plain>旧版备注内容</plain></notes>` +
      `<children><topics type="attached">` +
      `<topic id="t2" branch="folded"><title>分支一</title><children><topics type="attached"><topic id="t3"><title>叶子节点</title></topic></topics></children></topic>` +
      `<topic id="t4"><title>分支二</title></topic>` +
      `</topics></children></topic></sheet></xmap-content>`;
    const bytes = createZip([{ name: "content.xml", data: new TextEncoder().encode(xml) }]);
    const parsed = await parseXmindToMindMap(bytes);
    expect(parsed.sheetCount).toBe(1);
    expect(parsed.topicCount).toBe(4);
    const root = parsed.mind.find((t) => t.parent === null)!;
    expect(root.text).toBe("XMind 8 根节点");
    expect(parsed.mindDescriptions[root.id]).toBe("旧版备注内容");
    const branch1 = parsed.mind.find((t) => t.text === "分支一")!;
    expect(parsed.mindCollapsed).toContain(branch1.id);
  });

  it("rejects empty export and invalid archives cleanly with XmindError", async () => {
    expect(() => exportMindMapToXmind({ mind: [] })).toThrow(XmindError);
    await expect(parseXmindToMindMap(new Uint8Array([0, 1, 2]))).rejects.toThrow(XmindError);
    const missing = createZip([{ name: "readme.txt", data: new TextEncoder().encode("hi") }]);
    await expect(parseXmindToMindMap(missing)).rejects.toThrow(XmindError);
  });
});
