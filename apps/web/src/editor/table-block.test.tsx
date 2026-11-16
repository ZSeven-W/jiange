import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TableBlock, gripMenu } from "./table-block";

const data = JSON.stringify([["a", "b", "c"], ["d", "e", "f"]]);
const noop = () => {};

describe("Feishu table block", () => {
  it("renders row and column grips for editors", () => {
    const html = renderToStaticMarkup(<TableBlock data={data} onEdit={noop} onChange={noop} onDelete={noop} readOnly={false} />);
    expect(html.match(/data-table-col-grip=/g)).toHaveLength(3);
    expect(html.match(/data-table-row-grip=/g)).toHaveLength(2);
    expect(html.match(/<textarea/g)).toHaveLength(6);
  });
  it("opens a row menu and highlights the selected row", () => {
    const html = renderToStaticMarkup(<TableBlock data={data} onEdit={noop} onChange={noop} onDeleteSelection={() => null} onDelete={noop} readOnly={false} initialGrip={{ kind: "row", index: 1 }} />);
    expect(html).toContain('data-table-grip-menu="row"');
    expect(html.match(/data-cell-selected="true"/g)).toHaveLength(3);
    expect(html).toContain('aria-label="更多表格操作"');
    expect(html).not.toContain('data-table-del=');
    expect(html).toContain('aria-label="删除选中行"');
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
  it("new Feishu tables have two blank rows and three columns without a header", async () => {
    const { NEW_TABLE } = await import("./model");
    expect(NEW_TABLE).toEqual([["", "", ""], ["", "", ""]]);
    const plain = renderToStaticMarkup(<TableBlock data={JSON.stringify(NEW_TABLE)} header={false} onHeader={noop} onEdit={noop} onChange={noop} onDelete={noop} readOnly={false} />);
    expect(plain).not.toContain("bg-[#F5F6F7]");
    expect(plain).toContain('data-table-header');
    expect(plain).toContain('aria-pressed="false"');
    expect(renderToStaticMarkup(<TableBlock data={data} onEdit={noop} onDelete={noop} readOnly />)).toContain("bg-[#F5F6F7]");
  });
});
