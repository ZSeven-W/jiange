import type { DocView } from "@/lib/api";
import { tableRowsOf } from "@/editor/table-cells";
import { coverMap, parseMerges } from "@/editor/table-ops";
import { readFlow } from "@/editor/flowchart/model";

export interface DocumentTextStats { characters: number; nonWhitespace: number }
const TEXT_TYPES = new Set(["paragraph", "h1", "h2", "h3", "h4", "h5", "h6", "bullet", "ordered", "todo", "quote", "code", "callout"]);

/** Count visible text in the loaded document, excluding its title and hidden merged cells. */
export function documentTextStats(view: DocView): DocumentTextStats {
  const result = { characters: 0, nonWhitespace: 0 };
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    for (const character of value) {
      result.characters++;
      if (!/\s/u.test(character)) result.nonWhitespace++;
    }
  };
  for (const block of view.blocks) {
    if (TEXT_TYPES.has(block.type)) for (const span of block.spans) { if (!span.marks.math) add(span.text); }
    else if (block.type === "table") {
      const rows = tableRowsOf(block.props);
      let cols = 0;
      for (const row of rows) if (Array.isArray(row)) cols = Math.max(cols, row.length);
      const covered = coverMap(parseMerges(block.props.tableMerges, rows.length, cols));
      rows.forEach((row, r) => { if (Array.isArray(row)) row.forEach((cell, c) => { if (covered.get(`${r}:${c}`) !== "hidden") add(cell); }); });
    } else if (block.type === "image") add(block.props.caption);
    else if (block.type === "flowchart") {
      const flow = readFlow(block.props);
      for (const node of flow.nodes) add(node.text);
      for (const edge of flow.edges) add(edge.label);
    }
  }
  return result;
}
