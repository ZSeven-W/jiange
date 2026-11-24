import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BaseRecord, Field } from "@/lib/api";
import {
  addGanttDependency,
  computeGanttArrowPath,
  removeGanttDependency,
  sanitizeGanttDependencies,
  wouldCreateGanttCycle,
} from "./gantt-dependencies";
import { Gantt } from "./gantt";

const fields: Field[] = [
  { id: 1, name: "任务", type: "text", position: 0 },
  { id: 2, name: "开始", type: "date", position: 1 },
  { id: 3, name: "结束", type: "date", position: 2 },
];
const record = (id: number, start: string, end: string): BaseRecord => ({
  id,
  baseId: 42,
  position: id,
  cells: { 1: `任务${id}`, 2: start, 3: end },
});

describe("gantt dependencies helper", () => {
  it("detects self-loops, direct cycles, and deep transitive cycles while allowing diamond DAGs", () => {
    const chain = [
      { fromId: 1, toId: 2 },
      { fromId: 2, toId: 3 },
      { fromId: 3, toId: 4 },
    ];
    expect(wouldCreateGanttCycle(chain, 2, 2)).toBe(true);
    expect(wouldCreateGanttCycle(chain, 2, 1)).toBe(true);
    expect(wouldCreateGanttCycle(chain, 4, 1)).toBe(true);
    expect(wouldCreateGanttCycle(chain, 4, 2)).toBe(true);

    // Diamond DAG: 1 -> 2, 1 -> 5, 5 -> 4 is acyclic.
    const withBranch = [...chain, { fromId: 1, toId: 5 }];
    expect(wouldCreateGanttCycle(withBranch, 5, 4)).toBe(false);
    expect(wouldCreateGanttCycle(withBranch, 1, 4)).toBe(false);
  });

  it("adds, rejects invalid/duplicate/cyclic edges, and removes edges cleanly", () => {
    const r1 = addGanttDependency([], 1, 2);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    expect(addGanttDependency(r1.edges, 1, 1)).toEqual({ ok: false, reason: "self" });
    expect(addGanttDependency(r1.edges, 1, 2)).toEqual({ ok: false, reason: "duplicate" });
    expect(addGanttDependency(r1.edges, 2, 1)).toEqual({ ok: false, reason: "cycle" });
    expect(addGanttDependency(r1.edges, 0, 2)).toEqual({ ok: false, reason: "invalid" });

    const r2 = addGanttDependency(r1.edges, 2, 3);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(addGanttDependency(r2.edges, 3, 1)).toEqual({ ok: false, reason: "cycle" });

    const afterRemove = removeGanttDependency(r2.edges, r1.edge.id);
    expect(afterRemove).toHaveLength(1);
    expect(afterRemove[0].fromId).toBe(2);
    expect(addGanttDependency(afterRemove, 3, 1).ok).toBe(true);
  });

  it("sanitizes cloud-persisted view.config.ganttDeps by dropping duplicates, self-loops, and cycles", () => {
    const raw = [
      { id: "a", fromId: 1, toId: 2 },
      { id: "dup", fromId: 1, toId: 2 },
      { id: "self", fromId: 2, toId: 2 },
      { id: "cyc", fromId: 2, toId: 1 },
      { id: "bad", fromId: "x", toId: 3 },
      { id: "b", fromId: 2, toId: 3 },
    ];
    expect(sanitizeGanttDependencies(raw)).toEqual([
      { id: "a", fromId: 1, toId: 2 },
      { id: "b", fromId: 2, toId: 3 },
    ]);
    expect(sanitizeGanttDependencies(null)).toEqual([]);
  });

  it("computes orthogonal SVG elbow paths for forward, same-row, and overlapping bars", () => {
    const forward = computeGanttArrowPath(100, 20, 220, 61);
    expect(forward).toBe("M 100 20 H 118 V 61 H 220");

    const sameRow = computeGanttArrowPath(100, 20, 180, 20);
    expect(sameRow).toBe("M 100 20 H 180");

    const detour = computeGanttArrowPath(200, 20, 120, 61);
    expect(detour).toBe("M 200 20 H 212 V 40.5 H 108 V 61 H 120");
  });

  it("renders cloud-persisted dependencies prop and SVG elbow arrow layer in Gantt view", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
    try {
      const html = renderToStaticMarkup(
        createElement(Gantt, {
          baseId: 42,
          canEdit: true,
          fields,
          records: [record(1, "2026-11-05", "2026-11-10"), record(2, "2026-11-14", "2026-11-20")],
          members: [],
          dependencies: [{ id: "dep-1-2", fromId: 1, toId: 2 }],
          onChangeDependencies: () => {},
          onMutate: () => {},
        }),
      );
      expect(html).toContain("data-gantt-deps-btn");
      expect(html).toContain("依赖连线");
      expect(html).toContain("data-gantt-dep-layer");
      expect(html).toContain('data-gantt-dep-edge="1-&gt;2"');
      expect(html).toContain("<marker");
      expect(html).not.toContain("<select");
      expect(html).not.toContain("pointer-events-none absolute inset-0");
    } finally {
      vi.useRealTimers();
    }
  });
});
