import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DocMeta, Me } from "@/lib/api";
import { DriveUploadManager } from "./drive-upload";
import { Home } from "./home";
import { homeViewKey, readHomeView, writeHomeView } from "./home-view";

afterEach(() => vi.unstubAllGlobals());
describe("home view preferences", () => {
  it("isolates each user and survives inaccessible or invalid storage", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(readHomeView(storage, 1)).toBe("list");
    writeHomeView(storage, 1, "grid");
    expect(readHomeView(storage, 1)).toBe("grid");
    expect(readHomeView(storage, 2)).toBe("list");
    values.set(homeViewKey(2), "unknown");
    expect(readHomeView(storage, 2)).toBe("list");
    expect(readHomeView({ getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } }, 1)).toBe("list");
    expect(() => writeHomeView({ getItem: () => null, setItem: () => { throw new Error("blocked"); } }, 1, "grid")).not.toThrow();
    expect(readHomeView(storage, 0)).toBe("list");
  });
  it("renders the same recent data as navigable cards when grid is selected", () => {
    const me: Me = { user: { id: 7, name: "测试", email: "test@example.test", createdAt: "2026-01-01" }, workspaces: [] };
    const doc: DocMeta = { id: 1, title: "项目计划", updatedAt: "2026-11-01", workspaceId: 1, parentId: null, icon: "", creatorId: 7, creatorName: "测试", createdAt: "2026-01-01", role: "manage" };
    vi.stubGlobal("window", { localStorage: { getItem: (key: string) => key === homeViewKey(7) ? "grid" : null } });
    const qc = new QueryClient(); qc.setQueryData(["docs"], [doc]); qc.setQueryData(["recent", 7], [{ ...doc, viewedAt: "2026-11-03" }]);
    const html = renderToStaticMarkup(<QueryClientProvider client={qc}><Home me={me} uploads={new DriveUploadManager(7, () => {})}/></QueryClientProvider>);
    expect(html).toContain("data-home-grid");
    expect(html).toContain("项目计划");
    expect(html).toContain("最近修改于");
    expect(html).toContain('aria-label="卡片视图" aria-pressed="true"');
  });
});
