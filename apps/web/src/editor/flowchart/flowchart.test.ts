import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx } from "@jiange/collab";
import { autoLayout, edgePath, flowWrites, normalizeNode, readFlow, toMermaid, type FlowGraph } from "./model";
import { labelText, parseDrawio, toDrawio, DrawioError } from "./drawio";
import { flowchartPrompt, parseFlowchartAnswer } from "./ai";

const sample: FlowGraph = {
  theme: "classic",
  nodes: [
    { id: "a", shape: "terminator", text: "开始", x: 0, y: 0, w: 120, h: 50 },
    { id: "b", shape: "diamond", text: "通过？", x: 0, y: 120, w: 140, h: 90 },
    { id: "c", shape: "rect", text: "结束", x: 0, y: 280, w: 120, h: 50 },
  ],
  edges: [{ id: "e1", from: "a", to: "b" }, { id: "e2", from: "b", to: "c", label: "是" }],
};

describe("flowchart storage", () => {
  it("round-trips through per-object props and only writes what changed", () => {
    const first = flowWrites({}, sample);
    expect(Object.keys(first).filter((k) => k.startsWith("fc.n.")).length).toBe(3);
    const props = { ...first };
    expect(readFlow(props).nodes.map((n) => n.text).sort()).toEqual(["开始", "结束", "通过？"].sort());
    expect(readFlow(props).edges.map((e) => e.label ?? "")).toEqual(["", "是"]);
    const moved = { ...sample, nodes: sample.nodes.map((n) => (n.id === "c" ? { ...n, x: 300 } : n)) };
    expect(Object.keys(flowWrites(props, moved))).toEqual(["fc.n.c"]);
    const removed = { ...sample, nodes: sample.nodes.filter((n) => n.id !== "c"), edges: sample.edges.filter((e) => e.to !== "c") };
    expect(flowWrites(props, removed)).toEqual({ "fc.n.c": "", "fc.e.e2": "" });
  });
  it("keeps both users' concurrent edits to different nodes", () => {
    const a = new Doc(1), b = new Doc(2);
    const tx = new Tx(a);
    const block = tx.create("flowchart", null, ROOT, flowWrites({}, sample));
    for (const op of tx.ops) b.apply(op);
    const editA = new Tx(a), editB = new Tx(b);
    const ga = readFlow(a.blockInfo(block).props), gb = readFlow(b.blockInfo(block).props);
    for (const [k, v] of Object.entries(flowWrites(a.blockInfo(block).props, { ...ga, nodes: ga.nodes.map((n) => (n.id === "a" ? { ...n, text: "启动" } : n)) }))) editA.setProp(block, k, v);
    for (const [k, v] of Object.entries(flowWrites(b.blockInfo(block).props, { ...gb, nodes: gb.nodes.map((n) => (n.id === "c" ? { ...n, text: "完成" } : n)) }))) editB.setProp(block, k, v);
    for (const op of editA.ops) b.apply(op);
    for (const op of editB.ops) a.apply(op);
    for (const d of [a, b]) {
      const texts = Object.fromEntries(readFlow(d.blockInfo(block).props).nodes.map((n) => [n.id, n.text]));
      expect(texts).toEqual({ a: "启动", b: "通过？", c: "完成" });
    }
  });
  it("rejects malformed objects and dangling edges", () => {
    expect(normalizeNode({ x: "1" }, "bad id!")).toBeNull();
    const g = readFlow({ "fc.n.a": '{"x":0,"y":0,"w":10,"h":10,"shape":"weird","text":"x","fill":"red"}', "fc.e.e": '{"from":"a","to":"missing"}', "fc.n.z": "not json" });
    expect(g.nodes[0]).toMatchObject({ shape: "rect", w: 20 });
    expect(g.nodes[0].fill).toBeUndefined();
    expect(g.edges).toEqual([]);
  });
});

describe("layout, routing and export", () => {
  it("lays out ranks top-to-bottom and survives cycles", () => {
    const cyc = { ...sample, edges: [...sample.edges, { id: "e3", from: "c", to: "a" }] };
    const out = autoLayout(cyc);
    const y = Object.fromEntries(out.nodes.map((n) => [n.id, n.y]));
    expect(y.a).toBeLessThan(y.b);
    expect(y.b).toBeLessThan(y.c);
  });
  it("routes orthogonal edges and writes Mermaid", () => {
    const { d } = edgePath(sample.edges[0], sample.nodes[0], sample.nodes[1]);
    expect(d.startsWith("M60,50")).toBe(true);
    const m = toMermaid(sample);
    expect(m).toContain('N1(["开始"])');
    expect(m).toContain('N2 -->|"是"| N3');
  });
});

describe("draw.io import", () => {
  const plain = `<mxfile><diagram name="P1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="s" value="开始" style="ellipse;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1"><mxGeometry x="100" y="40" width="120" height="60" as="geometry"/></mxCell>
    <mxCell id="d" value="&lt;b&gt;是否&lt;/b&gt;&lt;br&gt;通过" style="rhombus;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="100" y="160" width="120" height="80" as="geometry"/></mxCell>
    <mxCell id="g" value="" style="group" vertex="1" parent="1"><mxGeometry x="400" y="300" width="200" height="100" as="geometry"/></mxCell>
    <mxCell id="in" value="组内" style="rounded=1;" vertex="1" parent="g"><mxGeometry x="10" y="20" width="100" height="40" as="geometry"/></mxCell>
    <mxCell id="e1" value="" style="edgeStyle=orthogonalEdgeStyle;dashed=1;" edge="1" parent="1" source="s" target="d"><mxGeometry relative="1" as="geometry"/></mxCell>
    <mxCell id="lbl" value="否" style="edgeLabel;" vertex="1" connectable="0" parent="e2"><mxGeometry relative="1" as="geometry"/></mxCell>
    <mxCell id="e2" value="" style="endArrow=none;" edge="1" parent="1" source="d" target="in"><mxGeometry relative="1" as="geometry"/></mxCell>
    <mxCell id="e3" value="悬空" edge="1" parent="1" source="d"><mxGeometry relative="1" as="geometry"/></mxCell>
  </root></mxGraphModel></diagram><diagram name="P2"><mxGraphModel><root/></mxGraphModel></diagram></mxfile>`;
  it("imports shapes, colours, groups, labels and edge styles", async () => {
    const { graph, warnings } = await parseDrawio(plain);
    const byText = Object.fromEntries(graph.nodes.map((n) => [n.text, n]));
    expect(byText["开始"]).toMatchObject({ shape: "ellipse", fill: "#DAE8FC", stroke: "#6C8EBF" });
    expect(byText["是否\n通过"].shape).toBe("diamond");
    expect(byText["组内"]).toMatchObject({ shape: "round", x: byText["开始"].x + 310, y: byText["开始"].y + 280 });
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges.find((e) => e.dashed)?.kind ?? "orthogonal").toBe("orthogonal");
    expect(graph.edges.find((e) => e.arrow === "none")?.kind).toBe("straight");
    expect(graph.edges.find((e) => e.arrow === "none")?.label).toBe("否");
    expect(warnings.join()).toContain("只导入了第一页");
    expect(warnings.join()).toContain("1 条未连接");
  });
  it("decodes compressed diagrams and round-trips its own export", async () => {
    const inner = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="A" style="" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell></root></mxGraphModel>`;
    const deflated = new Uint8Array(await new Response(new Blob([new TextEncoder().encode(encodeURIComponent(inner))]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
    const b64 = btoa(String.fromCharCode(...deflated));
    const { graph } = await parseDrawio(`<mxfile><diagram id="x">${b64}</diagram></mxfile>`);
    expect(graph.nodes[0].text).toBe("A");
    const again = await parseDrawio(toDrawio(sample));
    expect(again.graph.nodes.map((n) => n.shape).sort()).toEqual(["diamond", "rect", "terminator"]);
    expect(again.graph.edges.find((e) => e.label === "是")).toBeTruthy();
  });
  it("rejects non-draw.io and DOCTYPE input", async () => {
    await expect(parseDrawio("<html></html>")).rejects.toBeInstanceOf(DrawioError);
    await expect(parseDrawio('<!DOCTYPE x [<!ENTITY a "b">]><mxfile/>')).rejects.toBeInstanceOf(DrawioError);
    expect(labelText("a&nbsp;<i>b</i><div>c</div>")).toBe("a b\nc");
  });
});

describe("AI flowchart", () => {
  it("validates model output strictly and lays it out", () => {
    const out = parseFlowchartAnswer('结果：{"direction":"LR","nodes":[{"id":"s","text":"开始","shape":"terminator"},{"id":"x","text":"处理","shape":"cloud"},{"id":"bad id"}],"edges":[{"from":"s","to":"x","label":"下一步"},{"from":"s","to":"nope"}]}');
    expect(out?.graph.nodes.map((n) => n.shape)).toEqual(["terminator", "rect"]);
    expect(out?.graph.edges).toHaveLength(1);
    expect(out?.dropped).toBe(2);
    const xs = out!.graph.nodes.map((n) => n.x);
    expect(xs[1]).toBeGreaterThan(xs[0]);
    expect(parseFlowchartAnswer("抱歉")).toBeNull();
    expect(flowchartPrompt("注册流程")[0].content).toContain("terminator");
  });
});

describe("flowchart shapes and templates", () => {
  it("builds every template as a valid, storable graph", async () => {
    const { FLOW_TEMPLATES } = await import("./templates");
    for (const t of FLOW_TEMPLATES) {
      const g = t.build("feishu");
      expect(g.nodes.length).toBeGreaterThan(1);
      const back = readFlow(flowWrites({}, g));
      expect(back.nodes).toHaveLength(g.nodes.length);
      expect(back.edges).toHaveLength(g.edges.length);
    }
    // Swimlanes stay beneath the shapes inside them.
    const lanes = FLOW_TEMPLATES.find((t) => t.id === "swimlane")!.build("feishu");
    const order = readFlow(flowWrites({}, lanes)).nodes.map((n) => n.shape);
    expect(order.lastIndexOf("swimlane")).toBeLessThan(order.indexOf("terminator"));
  });

  it("round-trips lane, class, actor and lifeline shapes through draw.io", async () => {
    const g: FlowGraph = { theme: "feishu", nodes: (["swimlane", "swimlaneV", "class", "actor", "lifeline", "note", "triangle"] as const).map((shape, i) => ({ id: `s${i}`, shape, text: shape, x: i * 200, y: 0, w: 160, h: 120, align: i === 2 ? "left" : undefined })), edges: [] };
    const back = await parseDrawio(toDrawio(g));
    expect(back.graph.nodes.map((n) => n.shape).sort()).toEqual(g.nodes.map((n) => n.shape).sort());
    expect(normalizeNode({ id: "x", shape: "class", align: "left" })?.align).toBe("left");
    expect(normalizeNode({ id: "x", shape: "class", align: "justify" })?.align).toBeUndefined();
  });
});

describe("rotation and bends", () => {
  it("rotates ports with the shape and keeps edges facing the other node", async () => {
    const { portPoint, worldSide } = await import("./model");
    const n = { id: "r", shape: "rect" as const, text: "", x: 0, y: 0, w: 100, h: 40, rot: 90 };
    const top = portPoint(n, "top");
    expect(Math.round(top.x)).toBe(70);
    expect(Math.round(top.y)).toBe(20);
    expect(worldSide(n, "top")).toBe("right");
    const a = { ...n, id: "a" }, b = { id: "b", shape: "rect" as const, text: "", x: 0, y: 200, w: 100, h: 40 };
    // Auto ports: the rotated node still leaves from its world-bottom side.
    const { d } = edgePath({ id: "e", from: "a", to: "b" }, a, b);
    expect(d.startsWith("M50,70")).toBe(true);
  });

  it("pins the orthogonal middle segment and normalizes rot/mid", async () => {
    const a = { id: "a", shape: "rect" as const, text: "", x: 0, y: 0, w: 100, h: 40 }, b = { id: "b", shape: "rect" as const, text: "", x: 100, y: 300, w: 100, h: 40 };
    const { d } = edgePath({ id: "e", from: "a", to: "b", mid: 150 }, a, b);
    expect(d).toContain("50,150");
    expect(d).toContain("150,150");
    expect(normalizeNode({ id: "x", rot: 450 })?.rot).toBe(90);
    expect(normalizeNode({ id: "x", rot: 360 })?.rot).toBeUndefined();
    const back = await parseDrawio(toDrawio({ theme: "feishu", nodes: [{ ...a, rot: 45 }], edges: [] }));
    expect(back.graph.nodes[0].rot).toBe(45);
  });
});
