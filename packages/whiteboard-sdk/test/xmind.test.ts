import { describe, expect, it, vi } from "vitest";
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
    expect(() => exportMindMapToXmind({})).toThrow(XmindError);
    expect(() => exportMindMapToXmind({ mind: [] })).toThrow(XmindError);
    await expect(parseXmindToMindMap(new Uint8Array([0, 1, 2]))).rejects.toThrow(XmindError);
    await expect(parseXmindToMindMap(null as unknown as Uint8Array)).rejects.toThrow("无法解析 XMind 文件");
    const missing = createZip([{ name: "readme.txt", data: new TextEncoder().encode("hi") }]);
    await expect(parseXmindToMindMap(missing)).rejects.toThrow(XmindError);
  });

  it("handles color shorthands, extra shapes, tie-break sorting, combined text decorations, detached/untitled topics, and description clamping", async () => {
    // Export edge cases: equal orders (id tie-break), empty root titles (fallback to options.title and 画布 N), underline+strike
    const graph: FlowGraph = {
      theme: "feishu",
      nodes: [],
      edges: [],
      mind: [
        { id: "r_b", parent: null, order: 1000, text: "   ", x: 0, y: 0 },
        { id: "r_a", parent: null, order: 1000, text: "", x: 0, y: 200 },
        { id: "c_b", parent: "r_a", order: 1000, text: "Child B" },
        { id: "c_a", parent: "r_a", order: 1000, text: "Child A" },
      ],
      mindTextFormats: {
        c_a: { underline: true, strike: true },
      },
    };
    const withTitle = exportMindMapToXmind(graph, { title: "自定义画布" });
    const withoutTitle = exportMindMapToXmind(graph);
    expect(withTitle.length).toBeGreaterThan(0);
    expect(withoutTitle.length).toBeGreaterThan(0);

    // Import JSON single-sheet object (non-array), 3-digit & invalid hex colors, lowercase rect/diamond/parallelogram/unknown shapes,
    // detached children, missing/non-string titles, whitespace-only notes, and >128-line clamped notes
    const longNote = Array.from({ length: 150 }, (_, i) => `L${i}`).join("\n");
    const singleSheet = {
      id: "s1",
      rootTopic: {
        id: "t0",
        // omit title to test fallback "主题"
        notes: { plain: { content: "   \0  " } },
        style: {
          properties: {
            "shape-class": "org.xmind.topicShape.rect",
            "fo:color": "#abc",
            "svg:fill": "not-a-color",
          },
        },
        children: {
          attached: [
            {
              id: "t1",
              title: "Diamond",
              notes: { plain: { content: longNote } },
              style: { properties: { "shape-class": "org.xmind.topicShape.diamond" } },
            },
            {
              id: "t2",
              title: "Parallelogram",
              style: { properties: { "shape-class": "org.xmind.topicShape.parallelogram" } },
            },
          ],
          detached: [
            {
              id: "t3",
              title: "UnknownShape",
              style: { properties: { "shape-class": "org.xmind.topicShape.cloud" } },
            },
          ],
        },
      },
    };
    const jsonZip = createZip([{ name: "content.json", data: new TextEncoder().encode(JSON.stringify(singleSheet)) }]);
    const parsedJson = await parseXmindToMindMap(jsonZip);
    expect(parsedJson.topicCount).toBe(4);
    const root = parsedJson.mind.find((m) => m.parent === null)!;
    expect(root.text).toBe("主题");
    expect(parsedJson.mindStyles[root.id]).toEqual({ shape: "rect", color: "#aabbcc" });
    expect(parsedJson.mindPaints[root.id]).toBeUndefined();
    expect(parsedJson.mindDescriptions[root.id]).toBeUndefined();
    const diamond = parsedJson.mind.find((m) => m.text === "Diamond")!;
    expect(parsedJson.mindStyles[diamond.id]).toEqual({ shape: "rect" });
    expect(parsedJson.mindDescriptions[diamond.id]!.split("\n").length).toBeLessThanOrEqual(128);
    const para = parsedJson.mind.find((m) => m.text === "Parallelogram")!;
    expect(parsedJson.mindStyles[para.id]).toEqual({ shape: "rect" });
    const unknown = parsedJson.mind.find((m) => m.text === "UnknownShape")!;
    expect(parsedJson.mindStyles[unknown.id]).toBeUndefined();

    // Legacy XML topic without <title> falls back to "主题"
    const untitledXml = `<?xml version="1.0" encoding="UTF-8"?><xmap-content><sheet id="s1"><topic id="t1"/></sheet></xmap-content>`;
    const xmlZip = createZip([{ name: "content.xml", data: new TextEncoder().encode(untitledXml) }]);
    const parsedXml = await parseXmindToMindMap(xmlZip);
    expect(parsedXml.mind[0].text).toBe("主题");
  });

  it("reports corrupt JSON/XML/ZIP entries, empty sheets, topic limit, and depth limit warnings", async () => {
    // Corrupt JSON
    const badJsonZip = createZip([{ name: "content.json", data: new TextEncoder().encode("{broken") }]);
    await expect(parseXmindToMindMap(badJsonZip)).rejects.toThrow("XMind content.json 格式损坏");

    // Corrupt ZIP checksum for content.json (triggers ZipError on readZipEntry)
    const validJsonBytes = createZip([
      { name: "content.json", data: new TextEncoder().encode(JSON.stringify([{ id: "s1", rootTopic: { id: "t1", title: "A" } }])) },
    ]);
    const corruptedJsonZip = new Uint8Array(validJsonBytes);
    corruptedJsonZip[45] ^= 0xff; // flip a byte inside content.json payload so CRC fails
    await expect(parseXmindToMindMap(corruptedJsonZip)).rejects.toThrow("读取 content.json 失败");

    // Unexpected non-ZipError while reading content.json
    const sliceSpyJson = vi.spyOn(Uint8Array.prototype, "slice").mockImplementationOnce(() => {
      throw new Error("boom json");
    });
    await expect(parseXmindToMindMap(validJsonBytes)).rejects.toThrow("读取 XMind 内容失败");
    sliceSpyJson.mockRestore();

    // Corrupt XML (triggers XmlError)
    const badXmlZip = createZip([{ name: "content.xml", data: new TextEncoder().encode("<xmap-content><unclosed>") }]);
    await expect(parseXmindToMindMap(badXmlZip)).rejects.toThrow("解析 content.xml 失败");

    // Unexpected non-Zip/Xml error while reading content.xml
    const validXmlBytes = createZip([
      { name: "content.xml", data: new TextEncoder().encode(`<xmap-content><sheet id="s1"><topic id="t1"><title>Ok</title></topic></sheet></xmap-content>`) },
    ]);
    const sliceSpyXml = vi.spyOn(Uint8Array.prototype, "slice").mockImplementationOnce(() => {
      throw new Error("boom xml");
    });
    await expect(parseXmindToMindMap(validXmlBytes)).rejects.toThrow("解析 XMind XML 失败");
    sliceSpyXml.mockRestore();

    // Empty sheets (no roots)
    const emptyJsonZip = createZip([{ name: "content.json", data: new TextEncoder().encode("[]") }]);
    await expect(parseXmindToMindMap(emptyJsonZip)).rejects.toThrow("未包含任何思维导图主题");

    // existingCount at limit (maxAllowed === 0)
    await expect(parseXmindToMindMap(validJsonBytes, { existingCount: 500 })).rejects.toThrow("已达上限");

    // Truncation across topics within a sheet AND across multiple sheets
    const multiSheet = [
      {
        id: "s1",
        rootTopic: {
          id: "r1",
          title: "Sheet 1",
          children: { attached: [{ id: "c1", title: "C1" }, { id: "c2", title: "C2" }] },
        },
      },
      { id: "s2", rootTopic: { id: "r2", title: "Sheet 2" } },
    ];
    const multiZip = createZip([{ name: "content.json", data: new TextEncoder().encode(JSON.stringify(multiSheet)) }]);
    const truncTopics = await parseXmindToMindMap(multiZip, { existingCount: 498 });
    expect(truncTopics.topicCount).toBe(2);
    expect(truncTopics.warnings.some((w) => w.includes("超过上限"))).toBe(true);

    // Depth limit (>32)
    let deep: Record<string, unknown> = { id: "leaf", title: "TooDeep" };
    for (let d = 33; d >= 0; d--) {
      deep = { id: `d${d}`, title: `D${d}`, children: { attached: [deep] } };
    }
    const deepZip = createZip([
      { name: "content.json", data: new TextEncoder().encode(JSON.stringify([{ id: "s1", rootTopic: deep }])) },
    ]);
    const truncDepth = await parseXmindToMindMap(deepZip);
    expect(truncDepth.topicCount).toBe(33);
    expect(truncDepth.warnings.some((w) => w.includes("超过 32 层"))).toBe(true);
  });
});
