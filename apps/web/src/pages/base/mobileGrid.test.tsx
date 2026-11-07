import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BaseRecord, Field } from "@/lib/api";
import { Grid } from "./Grid";

const fields: Field[] = [{ id: 1, name: "任务", type: "text", position: 1, isPrimary: true }];
const records: BaseRecord[] = [{ id: 9, baseId: 1, position: 1, cells: { 1: "准备会议" } }];
const renderGrid = (canEdit: boolean) => renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><Grid baseId={1} canEdit={canEdit} fields={fields} allFields={fields} records={records} members={[]} onMutate={() => {}} /></QueryClientProvider>);

describe("grid touch and keyboard affordances", () => {
  it("exposes an actionable record detail and field menu without requiring hover", () => {
    const html = renderGrid(true);
    expect(html).toContain('aria-label="展开记录 1"');
    expect(html).toContain('aria-label="字段菜单 任务"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('[@media(hover:none)]:flex');
    expect(html).toContain('[@media(hover:none)]:opacity-100');
    expect(html).toContain("focus-visible:opacity-100");
    expect(html).toContain("h-[31px]");
  });

  it("keeps record details available but does not expose field mutations to viewers", () => {
    const html = renderGrid(false);
    expect(html).toContain('aria-label="展开记录 1"');
    expect(html).not.toContain('aria-label="字段菜单 任务"');
    expect(html).not.toContain('data-touch-edit');
  });
});
