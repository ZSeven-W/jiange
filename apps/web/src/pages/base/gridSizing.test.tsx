import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BaseRecord, Field } from "@/lib/api";
import { Grid } from "./Grid";

describe("virtualized row sizing", () => {
  it("keeps rich cell contents in a fixed-height display box without dropping values", () => {
    const fields: Field[] = [
      { id: 1, name: "多选", type: "multi_select", options: ["甲", "乙", "丙"], position: 1 },
      { id: 2, name: "关联", type: "link", position: 2 },
      { id: 3, name: "附件", type: "attachment", position: 3 },
    ];
    const records: BaseRecord[] = [{ id: 7, baseId: 1, position: 1, cells: {
      1: ["甲", "乙", "丙"], 2: ["事项一", "事项二"],
      3: [{ id: 5, name: "报告.pdf", mime: "application/pdf", size: 10 }, { id: 6, name: "笔记.txt", mime: "text/plain", size: 10 }],
    } }];
    const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><Grid baseId={1} canEdit={false} fields={fields} records={records} members={[]} onMutate={() => {}} /></QueryClientProvider>);
    expect((html.match(/data-grid-cell-content/g) ?? [])).toHaveLength(3);
    expect((html.match(/h-\[31px\]/g) ?? [])).toHaveLength(3);
    expect(html).toContain("甲");
    expect(html).toContain("事项二");
    expect(html).toContain("笔记.txt");
  });
});
