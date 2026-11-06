import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type DocMeta, type Me } from "@/lib/api";
import { docMetaKey } from "./docMetaState";

const state = vi.hoisted(() => ({ unacked: 0, storageError: false, otherPending: false }));
vi.mock("@/lib/useSyncDoc", () => ({ useSyncDoc: () => ({
  client: { doc: null, unacked: state.unacked, status: "offline", blocked: null, setAwareness: () => {}, pendingOps: () => [] },
  version: 0, peers: [], status: "offline", caughtUp: false, ready: false,
  blocked: null, storageError: state.storageError, legacyPending: false, otherPending: state.otherPending,
  onBeforeRemote: () => () => {},
}) }));
vi.mock("@/editor/Editor", () => ({ Editor: ({ readOnly }: { readOnly: boolean }) => <div data-testid="body">{readOnly ? "只读正文" : "可编辑正文"}</div> }));
vi.mock("@/components/CollabText", () => ({ CollabText: () => <div>标题组件</div> }));

import { DocPage } from "./DocPage";

const me: Me = { user: { id: 1, email: "one@example.test", name: "测试", createdAt: "2026-01-01" }, workspaces: [] };
const metadata: DocMeta = { id: 7, workspaceId: 1, parentId: null, title: "保密标题", creatorId: 1, creatorName: "测试", icon: "", createdAt: "2026-01-01", updatedAt: "2026-01-01", role: "edit" };

function renderWith(error: unknown, withCache = true, account = me) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  const key = docMetaKey(7, 1);
  if (withCache) qc.setQueryData(key, metadata);
  const query = qc.getQueryCache().build(qc, { queryKey: key, queryFn: async () => metadata });
  if (error) query.setState({ status: "error", error: error as Error });
  return renderToStaticMarkup(<QueryClientProvider client={qc}><DocPage id={7} me={account} /></QueryClientProvider>);
}

describe("document access errors", () => {
  it("retains cached document as read-only for a temporary failure", () => {
    state.unacked = 0;
    const html = renderWith(new TypeError("network"));
    expect(html).toContain("暂时无法连接服务器");
    expect(html).toContain("只读正文");
    expect(html).not.toContain("可编辑正文");
    expect(html).not.toContain("文档不存在或无权访问");
  });

  it("hides cached content on access denial while preserving the pending backup entry", () => {
    state.unacked = 1;
    const html = renderWith(new ApiError(404, "not_found", "denied"));
    expect(html).toContain("文档不存在或无权访问");
    expect(html).toContain("下载本地备份");
    expect(html).not.toContain("保密标题");
    expect(html).not.toContain("只读正文");
    state.unacked = 0;
  });

  it("shows a retry state instead of a false access denial without cached metadata", () => {
    const html = renderWith(new ApiError(503, "error", "unavailable"), false);
    expect(html).toContain("暂时无法连接服务器");
    expect(html).toContain("重试");
    expect(html).not.toContain("文档不存在或无权访问");
  });

  it("does not reuse the prior account's document metadata", () => {
    const other = { ...me, user: { ...me.user, id: 2 } };
    const html = renderWith(null, true, other);
    expect(html).toContain("正在加载文档");
    expect(html).not.toContain("保密标题");
    expect(html).not.toContain("只读正文");
  });
});
