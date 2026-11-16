import { describe, expect, it } from "vitest";
import { flowBounds, readFlow } from "../src/model";
import fixture from "./fixtures/public-flow-projection.json";
import corpus from "./fixtures/public-flow-projection-corpus.json";

describe("Go public flowchart projection", () => {
  it("preserves the whiteboard SDK's visible nodes, edges, ink and mind-map styling", () => {
    const original = readFlow(fixture.input);
    const projected = readFlow(fixture.output);
    // Image node labels are never painted by the renderer.
    const expected = { ...original, nodes: original.nodes.map((node) => node.shape === "image" ? { ...node, text: "" } : node) };
    expect(projected).toEqual(expected);
    expect(flowBounds(projected)).toEqual(flowBounds(original));
    expect(JSON.stringify(fixture.output)).not.toContain("HIDDEN-");
    expect(projected.mindDescriptions?.child).toBe("工作说明");
    expect(projected.strokes?.[0].marker).toBe(true);
  });

  it.each(corpus)("matches SDK semantics for normal and malformed stored data", ({ input, output }) => {
    const original = readFlow(input);
    const projected = readFlow(output);
    const expected = { ...original, nodes: original.nodes.map((node) => node.shape === "image" ? { ...node, text: "" } : node) };
    expect(projected).toEqual(expected);
    expect(flowBounds(projected)).toEqual(flowBounds(original));
  });
});
