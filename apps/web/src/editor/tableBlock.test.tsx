import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TableBlock, gripMenu } from "./TableBlock";

const data = JSON.stringify([["a", "b", "c"], ["d", "e", "f"]]);
const noop = () => {};

describe("Feishu table block", () => {
  it("renders row and column grips for editors", () => {
    const html = renderToStaticMarkup(<TableBlock data={data} onEdit={noop} onChange={noop} onDelete={noop} readOnly={false} />);
    expect(html.match(/data-table-col-grip=/g)).toHaveLength(3);
    expect(html.match(/data-table-row-grip=/g)).toHaveLength(2);
  });
  it("opens a row menu and highlights the selected row", () => {
    const html = renderToStaticMarkup(<TableBlock data={data} onEdit={noop} onChange={noop} onDelete={noop} readOnly={false} initialGrip={{ kind: "row", index: 1 }} />);
    expect(html).toContain('data-table-grip-menu="row"');
    expect(html.match(/data-cell-selected="true"/g)).toHaveLength(3);
    expect(html).toContain("合并单元格");
    for (const label of ["在上方插入行", "在下方插入行", "清空本行", "删除本行"]) expect(html).toContain(label);
  });
  it("renders merged cells with spans and hides covered cells", () => {
    const html = renderToStaticMarkup(<TableBlock data={data} merges="[[0,0,2,2]]" onEdit={noop} onDelete={noop} readOnly />);
    expect(html).toContain('rowSpan="2"');
    expect(html).toContain('colSpan="2"');
    expect(html.match(/<td/g)).toHaveLength(3);
    expect(html).not.toContain("data-table-row-grip");
  });
  it("disables deleting the last row or column", () => {
    expect(gripMenu({ kind: "row", index: 0 }, 1, 3).find((i) => i.op.kind === "deleteRow")?.disabled).toBe(true);
    expect(gripMenu({ kind: "col", index: 0 }, 2, 1).find((i) => i.op.kind === "deleteCol")?.disabled).toBe(true);
    expect(gripMenu({ kind: "col", index: 1 }, 2, 3).map((i) => i.op)).toContainEqual({ kind: "insertCol", at: 2 });
  });
});
