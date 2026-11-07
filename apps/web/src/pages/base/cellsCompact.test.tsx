import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { BaseRecord, Field } from "@/lib/api";
import { CellView } from "./cells";

describe("compact grid cells", () => {
  it("shows the first item and an accurate remainder count without losing the full value", () => {
    const field: Field = { id: 1, name: "多选", type: "multi_select", options: ["甲", "乙", "丙"], position: 1 };
    const record: BaseRecord = { id: 1, baseId: 1, position: 1, cells: { 1: ["甲", "乙", "丙"] } };
    const compact = renderToStaticMarkup(<CellView field={field} record={record} members={[]} canEdit={false} compact />);
    expect(compact).toContain('title="甲、乙、丙"');
    expect(compact).toContain('aria-label="还有 2 项"');
    expect(compact).toContain(">甲</span>");
    expect(compact).not.toContain(">乙</span>");
    const full = renderToStaticMarkup(<CellView field={field} record={record} members={[]} canEdit={false} />);
    expect(full).toContain(">乙</span>");
    expect(full).toContain(">丙</span>");
  });
});
