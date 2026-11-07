import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DocMeta, Me, RecentDoc } from "@/lib/api";
import { Home } from "./Home";

const me: Me = { user: { id: 1, name: "测试", email: "test@example.test", createdAt: "2026-01-01" }, workspaces: [] };
const doc = (id: number, title: string, updatedAt: string): DocMeta => ({ id, title, updatedAt, workspaceId: 1, parentId: null, icon: "", creatorId: 1, creatorName: "测试", createdAt: "2026-01-01", role: "manage" });
const first = doc(1, "先访问的结果", "2026-01-01");
const second = doc(2, "后访问的结果", "2026-11-01");

function render(recent: RecentDoc[], error?: Error) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  qc.setQueryData(["docs"], [first, second]);
  qc.setQueryData(["recent", me.user.id], recent);
  if (error) qc.getQueryCache().build(qc, { queryKey: ["recent", me.user.id], queryFn: async () => recent }).setState({ status: "error", error });
  return renderToStaticMarkup(<QueryClientProvider client={qc}><Home me={me} /></QueryClientProvider>);
}

describe("home recent visits", () => {
  it("uses visit order rather than updatedAt and labels the time column", () => {
    const html = render([{ ...first, viewedAt: "2026-11-07T10:00:00Z" }, { ...second, viewedAt: "2026-11-07T09:00:00Z" }]);
    expect(html.indexOf(first.title)).toBeLessThan(html.indexOf(second.title));
    expect(html).toContain("最近访问");
    expect(html).toContain("最近更新");
  });

  it("does not substitute recently updated documents for an empty or failed history", () => {
    const empty = render([]);
    expect(empty).toContain("还没有最近访问的文档");
    expect(empty).not.toContain(first.title);
    const failed = render([{ ...first, viewedAt: "2026-11-07T10:00:00Z" }], new Error("network"));
    expect(failed).toContain("加载失败");
    expect(failed).not.toContain(first.title);
  });
});
