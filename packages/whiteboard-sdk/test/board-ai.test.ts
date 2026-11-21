import { describe, expect, it } from "vitest";
import { Board } from "../src/board.js";
import { fromMermaid } from "../src/mermaid.js";
import { renderBoardToSvg } from "../src/svg.js";
import { createWhiteboardTools } from "../src/ai-tools.js";
import { exportMindMapToXmindAsync } from "../src/xmind.js";

describe("whiteboard-sdk Board Facade, Mermaid parser, SVG renderer & AI tools", () => {
  it("parses Mermaid flowcharts (all shapes, arrows, labels) and mindmaps cleanly", () => {
    const flow = fromMermaid(`
      %% Architecture flow
      flowchart LR
        Start([Begin]) --> Check{Approved?}
        Check -->|Yes| DB[(Postgres)]
        Check -.->|Retry| Start
        DB <--> Cache((Redis))
        Cache --- Audit{{Audit Log}}
        Input[/Payload/] --> Check
        Round(Service) --> Input
    `);
    expect(flow.nodes.length).toBe(7);
    expect(flow.edges.length).toBe(7);
    expect(flow.nodes.find((n) => n.id === "Start")?.shape).toBe("terminator");
    expect(flow.nodes.find((n) => n.id === "Check")?.shape).toBe("diamond");
    expect(flow.nodes.find((n) => n.id === "DB")?.shape).toBe("cylinder");
    expect(flow.nodes.find((n) => n.id === "Cache")?.shape).toBe("ellipse");
    expect(flow.nodes.find((n) => n.id === "Audit")?.shape).toBe("hexagon");
    expect(flow.nodes.find((n) => n.id === "Input")?.shape).toBe("parallelogram");
    expect(flow.nodes.find((n) => n.id === "Round")?.shape).toBe("round");

    const mindGraph = fromMermaid(`
      mindmap
        root((Product Launch))
          Engineering
            WebGPU Engine
            Go CLI
          Marketing
            Docs
    `);
    expect(mindGraph.mind?.length).toBe(6);
    expect(mindGraph.mind?.[0].parent).toBeNull();
    expect(mindGraph.mind?.[0].text).toBe("Product Launch");

    expect(fromMermaid("").nodes).toEqual([]);
  });

  it("supports Board CRUD, atomic apply with dryRun/rollback, align/distribute, undo/redo, props & XMind DEFLATE round-trip", async () => {
    const board = Board.create({ theme: "classic" });
    expect(board.verify()[0].code).toBe("EMPTY_BOARD");
    expect(board.undo()).toBe(false);
    expect(board.redo()).toBe(false);

    // Dry run
    const dry = board.apply([{ op: "addNode", node: { id: "a", shape: "rect", text: "A" } }], { dryRun: true });
    expect(dry.ok).toBe(true);
    expect(dry.undoToken).toBeNull();
    expect(board.toGraph().nodes).toHaveLength(0);

    // Atomic rollback on invalid edge
    const bad = board.apply([
      { op: "addNode", node: { id: "a", shape: "rect", text: "A" } },
      { op: "addEdge", edge: { from: "a", to: "missing" } },
    ]);
    expect(bad.ok).toBe(false);
    expect(bad.applied).toBe(0);
    expect(board.toGraph().nodes).toHaveLength(0);

    // Full apply: nodes, edges, mindmap, strokes, layout, theme
    const res = board.apply([
      { op: "addNode", node: { id: "n1", shape: "terminator", text: "Start", x: 10, y: 10 } },
      { op: "addNode", node: { id: "n2", shape: "diamond", text: "Decide", x: 200, y: 10 } },
      { op: "addNode", node: { id: "n3", shape: "triangle", text: "End", x: 400, y: 10 } },
      { op: "addEdge", edge: { id: "e1", from: "n1", to: "n2", label: "go" } },
      { op: "addEdge", edge: { id: "e2", from: "n2", to: "n3", dashed: true, arrow: "both" } },
      { op: "updateNode", id: "n2", patch: { text: "Validate" } },
      { op: "updateEdge", id: "e1", patch: { label: "next" } },
      { op: "addMindTopic", topic: { id: "r1", parent: null, text: "Root Idea" } },
      { op: "addMindTopic", topic: { id: "c1", parent: "r1", text: "Child 1" } },
      { op: "addMindTopic", topic: { id: "c2", parent: "c1", text: "Leaf" } },
      { op: "updateMindTopic", id: "c1", patch: { text: "Branch A" } },
      { op: "addStroke", stroke: { id: "st1", points: [{ x: 0, y: 0 }, { x: 40, y: 40 }], color: "#ff7d00", width: 3, marker: true } },
      { op: "autoLayout", direction: "TB" },
      { op: "setTheme", theme: "dark" },
    ]);
    expect(res.ok).toBe(true);
    expect(res.applied).toBe(14);
    expect(res.undoToken).toBeTruthy();

    // Align & distribute
    board.alignNodes(["n1", "n2", "n3"], "left");
    board.alignNodes(["n1", "n2", "n3"], "center");
    board.alignNodes(["n1", "n2", "n3"], "right");
    board.alignNodes(["n1", "n2", "n3"], "top");
    board.alignNodes(["n1", "n2", "n3"], "middle");
    board.alignNodes(["n1", "n2", "n3"], "bottom");
    board.distributeNodes(["n1", "n2", "n3"], "horizontal");
    board.distributeNodes(["n1", "n2", "n3"], "vertical");

    // Inspect & query
    expect(board.inspect({ detail: "summary" }).nodeCount).toBe(3);
    expect(board.inspect({ detail: "full" }).nodes).toHaveLength(3);
    expect(board.inspect({ detail: "full", maxTokens: 60 }).truncated).toBe(true);
    expect(board.query({ text: "Validate" }).nodes).toHaveLength(1);
    expect(board.query({ connectedTo: "n2" }).edges).toHaveLength(2);
    expect(board.query({ shape: "triangle" }).nodes).toHaveLength(1);

    // SVG & Mermaid & props round-trip
    const svg = board.toSvg();
    expect(svg).toContain("<svg ");
    expect(svg).toContain('data-node-id="n1"');
    expect(svg).toContain('data-edge-id="e1"');
    expect(svg).toContain('data-mind-id="r1"');
    expect(svg).toContain('data-stroke-id="st1"');
    expect(board.toMermaid()).toContain("flowchart TD");
    const props = board.toProps();
    expect(Board.fromProps(props).toGraph().nodes).toHaveLength(3);

    // XMind DEFLATE round-trip
    const xmindDeflate = await board.toXmindAsync({ title: "Map" });
    const xmindStore = board.toXmind({ title: "Map" });
    expect(xmindDeflate.length).toBeLessThan(xmindStore.length);
    const { board: fromXm } = await Board.fromXmind(xmindDeflate);
    expect(fromXm.toGraph().mind?.length).toBe(3);
    expect((await exportMindMapToXmindAsync(board.toGraph())).length).toBeGreaterThan(0);

    // Delete subtree, stroke, edge, node + undo/redo
    const del = board.apply([
      { op: "deleteMindTopic", id: "c1" },
      { op: "deleteStroke", id: "st1" },
      { op: "deleteEdge", id: "e2" },
      { op: "deleteNode", id: "n3" },
    ]);
    expect(del.ok).toBe(true);
    expect(board.toGraph().mind).toHaveLength(1);
    expect(board.undo()).toBe(true);
    expect(board.toGraph().mind).toHaveLength(3);
    expect(board.redo()).toBe(true);
    expect(board.toGraph().mind).toHaveLength(1);
  });

  it("verifies structural issues (dangling edge, self-loop, isolated node, overlap, cycle, orphan mind topic)", () => {
    const board = Board.fromGraph({
      theme: "feishu",
      nodes: [
        { id: "a", x: 10, y: 10, w: 120, h: 60, shape: "rect", text: "A" },
        { id: "b", x: 20, y: 15, w: 120, h: 60, shape: "rect", text: "B" },
        { id: "iso", x: 400, y: 10, w: 120, h: 60, shape: "rect", text: "Lonely" },
      ],
      edges: [
        { id: "e1", from: "a", to: "b" },
        { id: "e2", from: "b", to: "a" },
        { id: "e3", from: "a", to: "a" },
        { id: "e4", from: "a", to: "ghost" },
      ],
      mind: [
        { id: "orphan", parent: "missing-root", order: 0, text: "Orphan" },
      ],
    });
    const codes = new Set(board.verify().map((d) => d.code));
    expect(codes.has("DANGLING_EDGE")).toBe(true);
    expect(codes.has("SELF_LOOP")).toBe(true);
    expect(codes.has("ISOLATED_NODE")).toBe(true);
    expect(codes.has("OVERLAPPING_NODES")).toBe(true);
    expect(codes.has("CYCLE_DETECTED")).toBe(true);
    expect(codes.has("ORPHAN_MIND_TOPIC")).toBe(true);

    // SVG rendering on empty graph fallback
    expect(renderBoardToSvg({ nodes: [], edges: [], theme: "feishu" })).toContain('viewBox="-32 -32');
  });

  it("exposes AI Tool definitions and executes all tools", () => {
    const board = Board.fromMermaid("flowchart TD\n  A[Start] --> B[End]");
    const runtime = createWhiteboardTools(board);
    expect(runtime.tools.length).toBe(8);

    const applyRes = runtime.execute("board_apply", {
      ops: [{ op: "addNode", node: { id: "C", shape: "round", text: "Next" } }],
      actor: "ai",
    }) as { ok: boolean };
    expect(applyRes.ok).toBe(true);
    expect((runtime.execute("board_inspect", { detail: "standard", maxTokens: 1000 }) as { nodeCount: number }).nodeCount).toBe(3);
    expect((runtime.execute("board_query", { text: "Next", shape: "round" }) as { nodes: unknown[] }).nodes).toHaveLength(1);
    expect(Array.isArray(runtime.execute("board_verify"))).toBe(true);
    expect((runtime.execute("board_auto_layout", { direction: "LR", gapX: 40, gapY: 40 }) as { nodes: unknown[] }).nodes).toHaveLength(3);
    expect((runtime.execute("board_export", { format: "svg" }) as { content: string }).content).toContain("<svg");
    expect((runtime.execute("board_export", { format: "mermaid" }) as { content: string }).content).toContain("flowchart TD");
    expect((runtime.execute("board_undo") as { undone: boolean }).undone).toBe(true);
    expect((runtime.execute("board_redo") as { redone: boolean }).redone).toBe(true);
    expect(() => runtime.execute("unknown")).toThrow();

    // Default / omitted optional args across all AI tools
    expect((runtime.execute("board_inspect") as { nodeCount: number }).nodeCount).toBe(3);
    expect((runtime.execute("board_query", { connectedTo: "A" }) as { nodes: unknown[] }).nodes.length).toBeGreaterThanOrEqual(1);
    expect((runtime.execute("board_apply", { atomic: false }) as { ok: boolean; applied: number })).toMatchObject({ ok: true, applied: 0 });
    expect((runtime.execute("board_auto_layout") as { nodes: unknown[] }).nodes).toHaveLength(3);
  });

  it("covers Mermaid edge cases: quoted/multiline labels, redeclared nodes, subgraphs, inline labels, standalone/invalid lines, and mindmap root fallbacks", () => {
    const flow = fromMermaid(
      `
      graph TD
        subgraph Cluster
          A -- inline label --> B["Quoted<br/>Label"]
          B --> C['Single Quoted']
          A[Redeclared Alpha] --> D[unclosed
          Solo((Standalone));
          ;
          !!! --> B
          A --> !!!
        end
        style A fill:#fff
      `,
      { autoLayout: false },
    );
    expect(flow.nodes.find((n) => n.id === "A")).toMatchObject({ shape: "rect", text: "Redeclared Alpha" });
    expect(flow.nodes.find((n) => n.id === "B")?.text).toBe("Quoted\nLabel");
    expect(flow.nodes.find((n) => n.id === "C")?.text).toBe("Single Quoted");
    expect(flow.nodes.find((n) => n.id === "D")?.text).toBe("[unclosed");
    expect(flow.nodes.find((n) => n.id === "Solo")?.shape).toBe("ellipse");
    expect(flow.edges.find((e) => e.from === "A" && e.to === "B")?.label).toBe("inline label");

    // Empty flowchart with only directives skips autoLayout
    expect(fromMermaid("flowchart TD\n  subgraph G\n  end").nodes).toEqual([]);

    // Mindmap with comments, blank lines, and empty-inner root fallback
    const mind = fromMermaid(`
      mindmap
        %% comment inside mindmap
        root(())

        root[NonEmpty]
          Child A
    `);
    expect(mind.mind?.length).toBe(3);
    expect(mind.mind?.[0].text).toBe("");
    expect(mind.mind?.[1].text).toBe("NonEmpty");
  });

  it("renders all SVG shapes, text alignments, empty/multiline text, rotations, mindmap styles/paints, dangling edges, and non-marker/empty strokes", () => {
    const svg = renderBoardToSvg(
      {
        theme: "feishu",
        nodes: [
          { id: "n_rect", shape: "rect", text: "Left\n\nAligned", x: 0, y: 0, w: 140, h: 60, align: "left", rot: 15 },
          { id: "n_round", shape: "round", text: "Right", x: 180, y: 0, w: 140, h: 60, align: "right" },
          { id: "n_term", shape: "terminator", text: "", x: 360, y: 0, w: 140, h: 52 },
          { id: "n_ellipse", shape: "ellipse", text: "Oval", x: 0, y: 100, w: 120, h: 70 },
          { id: "n_diamond", shape: "diamond", text: "If", x: 180, y: 100, w: 140, h: 90 },
          { id: "n_para", shape: "parallelogram", text: "IO", x: 360, y: 100, w: 150, h: 60 },
          { id: "n_hex", shape: "hexagon", text: "Prep", x: 0, y: 220, w: 150, h: 64 },
          { id: "n_tri", shape: "triangle", text: "Tri", x: 180, y: 220, w: 100, h: 86 },
          { id: "n_cyl", shape: "cylinder", text: "DB", x: 360, y: 220, w: 110, h: 80 },
          { id: "n_txt", shape: "text", text: "Note", x: 520, y: 0, w: 120, h: 36 },
        ],
        edges: [
          { id: "e_none", from: "n_rect", to: "n_round", arrow: "none" },
          { id: "e_dangling", from: "n_rect", to: "n_missing" },
        ],
        mind: [
          { id: "mr", parent: null, order: 0, text: "Root", x: 600, y: 200 },
          { id: "mc", parent: "mr", order: 1, text: "Child" },
        ],
        mindStyles: {
          mr: { shape: "oval", size: 20, color: "#111111" },
          mc: { shape: "rect" },
        },
        mindPaints: {
          mr: { fill: "#aabbcc", stroke: "#223344", width: 2 },
          mc: { fill: "none" },
        },
        strokes: [
          { id: "s_empty", points: [], color: "#000000", width: 2 },
          { id: "s_plain", points: [{ x: 10, y: 10 }, { x: 20, y: 30 }], color: "#3370ff", width: 2 },
        ],
      },
      { padding: 16, background: "#fafafa" },
    );
    expect(svg).toContain("<ellipse");
    expect(svg).toContain("<polygon");
    expect(svg).toContain('transform="rotate(15');
    expect(svg).toContain('text-anchor="start"');
    expect(svg).toContain('text-anchor="end"');
    expect(svg).toContain('data-edge-id="e_none"');
    expect(svg).not.toContain('data-edge-id="e_dangling"');
    expect(svg).toContain('data-stroke-id="s_plain"');
    expect(svg).not.toContain('data-stroke-id="s_empty"');
    expect(svg).toContain('fill="#aabbcc"');
  });

  it("covers Board error paths, non-atomic apply, undo cap, empty align/distribute, default inspect/query, and optional graph fields", async () => {
    const board = Board.fromGraph({
      theme: "feishu",
      nodes: [
        { id: "n1", shape: "rect", text: "One", x: 0, y: 0, w: 100, h: 50 },
        { id: "n2", shape: "rect", text: "Two", x: 200, y: 0, w: 100, h: 50 },
        { id: "n3", shape: "rect", text: "Three", x: 400, y: 0, w: 100, h: 50 },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2", pts: [{ x: 150, y: 25 }] },
        { id: "e2", from: "n2", to: "n3" },
      ],
      mindDescriptionStyles: { r1: { size: 14, color: "#112233" } },
    });

    // Default inspect() and query() with disconnected nodes/edges
    expect(board.inspect().nodes).toHaveLength(3);
    const q = board.query({ connectedTo: "n1" });
    expect(q.nodes.map((n) => n.id).sort()).toEqual(["n1", "n2"]);
    expect(q.edges.map((e) => e.id)).toEqual(["e1"]);

    // alignNodes (<2) and distributeNodes (<3) are no-ops
    board.alignNodes(["n1"], "left");
    board.distributeNodes(["n1", "n2"], "horizontal");
    expect(board.canUndo()).toBe(false);

    // Empty apply returns null undoToken
    expect(board.apply([]).undoToken).toBeNull();

    // Non-atomic apply covers every error branch + auto-id generation + unknown shape fallback + non-Error throw
    const throwingPatch = {};
    Object.defineProperty(throwingPatch, "text", {
      enumerable: true,
      get() {
        throw "non-error-throw";
      },
    });

    const nonAtomic = board.apply(
      [
        { op: "addNode", node: { id: "n_custom", shape: "unknown-shape" as never, text: "UnknownShape" } },
        { op: "addNode", node: { shape: "rect", text: "AutoDup1" } },
        { op: "addNode", node: { id: "n1", shape: "rect", text: "Dup" } },
        { op: "updateNode", id: "missing", patch: { text: "X" } },
        { op: "updateNode", id: "n1", patch: throwingPatch as never },
        { op: "deleteNode", id: "missing" },
        { op: "addEdge", edge: { id: "e1", from: "n1", to: "n2" } },
        { op: "addEdge", edge: { id: "e_missing_from", from: "missing-from", to: "n2" } },
        { op: "updateEdge", id: "missing", patch: { label: "X" } },
        { op: "deleteEdge", id: "missing" },
        { op: "updateMindTopic", id: "missing", patch: { text: "X" } },
        { op: "deleteMindTopic", id: "missing" },
        { op: "deleteStroke", id: "missing" },
        { op: "addMindTopic", topic: { parent: null, text: "AutoRoot" } },
        { op: "addMindTopic", topic: { id: "m_root", parent: null, text: "NamedRoot" } },
        { op: "addMindTopic", topic: { id: "m_root", parent: null, text: "DupRoot" } },
        { op: "addMindTopic", topic: { parent: "missing-parent", text: "Orphan" } },
        { op: "updateMindTopic", id: "still-missing", patch: { text: "X" } },
        { op: "deleteMindTopic", id: "still-missing" },
        { op: "addStroke", stroke: { points: [{ x: 0, y: 0 }, { x: 10, y: 10 }], color: "#000000", width: 2 } },
        { op: "deleteStroke", id: "still-missing" },
        { op: "autoLayout" },
      ],
      { atomic: false },
    );
    expect(nonAtomic.ok).toBe(false);
    expect(nonAtomic.applied).toBe(5);
    expect(nonAtomic.errors.length).toBe(17);
    expect(nonAtomic.errors.some((e) => e.includes("non-error-throw"))).toBe(true);
    expect(board.verify().some((d) => d.code === "ISOLATED_NODE")).toBe(true);

    // Stroke-only board is non-empty in verify()
    const strokeBoard = Board.fromGraph({
      theme: "feishu",
      nodes: [],
      edges: [],
      strokes: [{ id: "s1", points: [{ x: 0, y: 0 }], color: "#000000", width: 2 }],
    });
    expect(strokeBoard.verify()).toEqual([]);

    // Board.fromXmind with explicit theme option
    const xmindBytes = board.toXmind();
    const { board: themedXmind } = await Board.fromXmind(xmindBytes, { theme: "dark" });
    expect(themedXmind.toGraph().theme).toBe("dark");

    // Undo stack caps at 100 entries
    for (let i = 0; i < 105; i++) {
      board.apply([{ op: "setTheme", theme: i % 2 === 0 ? "classic" : "dark" }]);
    }
    let undoneCount = 0;
    while (board.undo()) undoneCount++;
    expect(undoneCount).toBe(100);
  });
});
