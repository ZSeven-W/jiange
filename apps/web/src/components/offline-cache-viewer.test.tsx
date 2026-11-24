import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import type { OfflineMutation, OfflineSnapshot } from "@/lib/offline-db";
import type { OfflineStateHookValue } from "@/lib/offline-sync";
import {
  OfflineCacheDrawer,
  OfflineCacheViewer,
  columnIndexToLetters,
  formatOfflineBytes,
  offlineSnapshotHref,
} from "./offline-cache-viewer";

const docSnapshot: OfflineSnapshot = {
  key: "doc:42",
  kind: "doc",
  resourceId: 42,
  title: "架构演进方案",
  updatedAt: new Date("2026-11-24T09:15:00Z").getTime(),
  sizeBytes: 2450,
  data: {
    id: 42,
    title: "架构演进方案",
    creatorName: "Alice",
    workspaceName: "产研团队",
    updatedAt: "2026-11-24T09:15:00Z",
    blocks: [
      { id: "b1", type: "heading1", spans: [{ text: "离线优先设计" }] },
      {
        id: "b2",
        type: "paragraph",
        spans: [
          { text: "支持 ", marks: {} },
          { text: "IndexedDB", marks: { code: true } },
          { text: " 持久化缓存。", marks: { bold: true } },
        ],
      },
      { id: "b3", type: "todo", props: { checked: true }, spans: [{ text: "完成 LRU 淘汰策略" }] },
    ],
  },
};

const sheetSnapshot: OfflineSnapshot = {
  key: "sheet:7",
  kind: "sheet",
  resourceId: 7,
  title: "Q4 预算明细",
  updatedAt: new Date("2026-11-24T09:20:00Z").getTime(),
  sizeBytes: 4096,
  data: {
    nodeId: 7,
    title: "Q4 预算明细",
    sheets: [
      {
        id: 1,
        nodeId: 7,
        title: "研发费用",
        pos: 0,
        rows: [
          { id: 10, pos: 0 },
          { id: 11, pos: 1 },
        ],
        columns: [
          { id: 20, pos: 0 },
          { id: 21, pos: 1 },
        ],
        cells: [
          { rowId: 10, columnId: 20, raw: "项目", style: { bold: true }, revision: 1 },
          { rowId: 10, columnId: 21, raw: "预算(万)", style: { bold: true }, revision: 1 },
          { rowId: 11, columnId: 20, raw: "云资源", revision: 1 },
          { rowId: 11, columnId: 21, raw: "120", revision: 1 },
        ],
      },
      {
        id: 2,
        nodeId: 7,
        title: "市场费用",
        pos: 1,
        rows: [{ id: 30, pos: 0 }],
        columns: [{ id: 40, pos: 0 }],
        cells: [{ rowId: 30, columnId: 40, raw: "投放计划", revision: 1 }],
      },
    ],
  },
};

const listSnapshot: OfflineSnapshot = {
  key: "list:docs",
  kind: "list",
  title: "全部文档",
  updatedAt: new Date("2026-11-24T09:25:00Z").getTime(),
  sizeBytes: 1200,
  data: {
    docs: [
      { id: 42, kind: "doc", title: "架构演进方案", creatorName: "Alice" },
      { id: 7, kind: "sheet", title: "Q4 预算明细", creatorName: "Bob" },
    ],
  },
};

const sampleQueue: OfflineMutation[] = [
  {
    id: "mut_1",
    resourceType: "doc",
    resourceId: 42,
    title: "更新文档标题",
    method: "PATCH",
    path: "/api/docs/42",
    body: { title: "架构演进方案 v2" },
    createdAt: new Date("2026-11-24T09:30:00Z").getTime(),
    retries: 2,
    lastError: "HTTP 503 Service Unavailable",
  },
  {
    id: "mut_2",
    resourceType: "sheet",
    resourceId: 7,
    title: "提交单元格修改",
    method: "POST",
    path: "/api/sheets/7/cells",
    body: { cells: [] },
    createdAt: new Date("2026-11-24T09:31:00Z").getTime(),
    retries: 0,
  },
];

function makeOfflineState(overrides: Partial<OfflineStateHookValue> = {}): OfflineStateHookValue {
  return {
    online: false,
    cachedSnapshots: [docSnapshot, sheetSnapshot, listSnapshot],
    pendingQueue: sampleQueue,
    offlineCollabCount: 0,
    syncing: false,
    lastSyncSummary: null,
    syncNow: vi.fn(async () => ({ synced: 0, failed: 0, remaining: 0, completedAt: Date.now() })),
    removeSnapshot: vi.fn(async () => {}),
    clearCache: vi.fn(async () => {}),
    removeQueuedItem: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("offline-cache-viewer helpers", () => {
  it("formats human bytes, spreadsheet columns, and resource routes accurately", () => {
    expect(formatOfflineBytes(0)).toBe("0 B");
    expect(formatOfflineBytes(512)).toBe("512 B");
    expect(formatOfflineBytes(1536)).toBe("1.5 KB");
    expect(formatOfflineBytes(2 * 1024 * 1024)).toBe("2.00 MB");

    expect(columnIndexToLetters(0)).toBe("A");
    expect(columnIndexToLetters(25)).toBe("Z");
    expect(columnIndexToLetters(26)).toBe("AA");

    expect(offlineSnapshotHref(docSnapshot)).toBe("#/doc/42");
    expect(offlineSnapshotHref(sheetSnapshot)).toBe("#/sheet/7");
    expect(offlineSnapshotHref(listSnapshot)).toBe("#/");
    expect(offlineSnapshotHref({ key: "list:recent", kind: "list" })).toBe("#/recent");
  });
});

describe("OfflineCacheDrawer", () => {
  it("returns null when closed", () => {
    expect(
      renderToStaticMarkup(
        <I18nProvider>
          <OfflineCacheDrawer open={false} onClose={() => {}} offlineState={makeOfflineState()} />
        </I18nProvider>,
      ),
    ).toBe("");
  });

  it("renders Tab 1 (已缓存内容) with snapshots, badges, sizes, open/delete/clear actions, and zero native select", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <OfflineCacheDrawer
          open
          onClose={() => {}}
          initialTab="snapshots"
          offlineState={makeOfflineState()}
        />
      </I18nProvider>,
    );

    expect(html).toContain('data-offline-cache-drawer=""');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('data-offline-tab="snapshots"');
    expect(html).toContain('data-offline-tab="queue"');
    expect(html).toContain("已缓存内容");
    expect(html).toContain("待同步队列");
    expect(html).toContain("离线模式");

    // Snapshot entries
    expect(html).toContain("架构演进方案");
    expect(html).toContain("Q4 预算明细");
    expect(html).toContain("全部文档");
    expect(html).toContain('data-offline-open-snapshot="doc:42"');
    expect(html).toContain('data-offline-delete-snapshot="doc:42"');
    expect(html).toContain("离线打开");
    expect(html).toContain('data-offline-clear-cache=""');
    expect(html).toContain("清空缓存");
    expect(html).toContain("2.4 KB");
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("renders Tab 2 (待同步队列) with method/path summary, retry badge, error notice, sync and discard buttons", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <OfflineCacheDrawer
          open
          onClose={() => {}}
          initialTab="queue"
          offlineState={makeOfflineState({ online: true })}
        />
      </I18nProvider>,
    );

    expect(html).toContain('data-offline-queue-item="mut_1"');
    expect(html).toContain('data-offline-queue-item="mut_2"');
    expect(html).toContain("PATCH");
    expect(html).toContain("/api/docs/42");
    expect(html).toContain("POST");
    expect(html).toContain("/api/sheets/7/cells");
    expect(html).toContain("已重试 2 次");
    expect(html).toContain('data-offline-queue-error=""');
    expect(html).toContain("HTTP 503 Service Unavailable");
    expect(html).toContain('data-offline-discard-mutation="mut_1"');
    expect(html).toContain("丢弃");
    expect(html).toContain('data-offline-drawer-sync-btn=""');
    expect(html).toContain("立即同步");
    expect(html).not.toMatch(/data-offline-drawer-sync-btn=""[^>]*\sdisabled=""/);
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("disables sync button in queue tab while offline and renders clean empty states when empty", () => {
    const offlineQueueHtml = renderToStaticMarkup(
      <I18nProvider>
        <OfflineCacheDrawer
          open
          onClose={() => {}}
          initialTab="queue"
          offlineState={makeOfflineState({ online: false })}
        />
      </I18nProvider>,
    );
    expect(offlineQueueHtml).toMatch(/data-offline-drawer-sync-btn=""[^>]*\sdisabled=""/);

    const emptySnapshotsHtml = renderToStaticMarkup(
      <I18nProvider>
        <OfflineCacheDrawer
          open
          onClose={() => {}}
          initialTab="snapshots"
          offlineState={makeOfflineState({ cachedSnapshots: [], pendingQueue: [] })}
        />
      </I18nProvider>,
    );
    expect(emptySnapshotsHtml).toContain('data-offline-snapshots-empty=""');
    expect(emptySnapshotsHtml).toContain("暂无离线缓存内容");

    const emptyQueueHtml = renderToStaticMarkup(
      <I18nProvider>
        <OfflineCacheDrawer
          open
          onClose={() => {}}
          initialTab="queue"
          offlineState={makeOfflineState({ cachedSnapshots: [], pendingQueue: [] })}
        />
      </I18nProvider>,
    );
    expect(emptyQueueHtml).toContain('data-offline-queue-empty=""');
    expect(emptyQueueHtml).toContain("暂无待同步修改");
  });

  it("embeds OfflineCacheViewer cleanly when initialViewerSnapshot is active", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <OfflineCacheDrawer
          open
          onClose={() => {}}
          initialViewerSnapshot={docSnapshot}
          offlineState={makeOfflineState()}
        />
      </I18nProvider>,
    );
    expect(html).toContain('data-offline-viewer=""');
    expect(html).toContain("离线只读预览 · 网络恢复后自动获取最新版本");
  });

  it("displays CRDT replica count, pending Sheet/Slides merge status, and conflict notice in drawer", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <OfflineCacheDrawer
          open
          onClose={() => {}}
          initialTab="queue"
          offlineState={makeOfflineState({
            online: true,
            pendingQueue: [],
            offlineCollabCount: 3,
            offlineCollabSummary: {
              totalCount: 3,
              docReplicaCount: 1,
              docPendingOpsCount: 6,
              sheetDeltaCount: 1,
              sheetEditCount: 4,
              slidesDraftCount: 1,
              pendingMergeCount: 3,
            },
            lastSyncSummary: {
              synced: 1,
              failed: 0,
              remaining: 2,
              completedAt: Date.now(),
              collabFlushed: 1,
              collabFailed: 0,
              collabConflicts: [
                {
                  kind: "sheet",
                  resourceId: 7,
                  worksheetId: 1,
                  row: 0,
                  col: 0,
                  reason: "value_conflict",
                },
              ],
            },
          })}
        />
      </I18nProvider>,
    );

    expect(html).toContain('data-offline-drawer-collab-count="3"');
    expect(html).toContain('data-offline-collab-status=""');
    expect(html).toContain("离线协同与自动合并");
    expect(html).toContain("文档 CRDT 副本 1 份（待合并操作 6 条）");
    expect(html).toContain("表格离线增量 1 份（4 个单元格）");
    expect(html).toContain("幻灯片离线草稿 1 份");
    expect(html).toContain("联网后将自动通过 CRDT 与增量策略合并 3 项离线协同修改");
    expect(html).toContain("检测到 1 处离线合并冲突（已按最新修改策略处理）");
    // Sync button enabled because sheet/slides collab deltas are pending while online
    expect(html).not.toMatch(/data-offline-drawer-sync-btn=""[^>]*\sdisabled=""/);
  });
});

describe("OfflineCacheViewer", () => {
  it("renders cached document metadata & blocks cleanly in read-only mode", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <OfflineCacheViewer snapshot={docSnapshot} online={false} onClose={() => {}} />
      </I18nProvider>,
    );

    expect(html).toContain('data-offline-viewer=""');
    expect(html).toContain('data-offline-viewer-kind="doc"');
    expect(html).toContain('data-offline-readonly-badge=""');
    expect(html).toContain("离线只读预览 · 网络恢复后自动获取最新版本");
    expect(html).toContain("架构演进方案");
    expect(html).toContain("Alice");
    expect(html).toContain("产研团队");
    expect(html).toContain('data-offline-doc-blocks=""');
    expect(html).toContain("离线优先设计");
    expect(html).toContain("IndexedDB");
    expect(html).toContain("完成 LRU 淘汰策略");
    expect(html).not.toContain('data-offline-viewer-online-btn=""');
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("renders cached spreadsheet worksheets & cells grid cleanly with zero native select", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <OfflineCacheViewer snapshot={sheetSnapshot} online onClose={() => {}} />
      </I18nProvider>,
    );

    expect(html).toContain('data-offline-viewer-kind="sheet"');
    expect(html).toContain('data-offline-sheet-tab="0"');
    expect(html).toContain('data-offline-sheet-tab="1"');
    expect(html).toContain("研发费用");
    expect(html).toContain("市场费用");
    expect(html).toContain('data-offline-sheet-table=""');
    expect(html).toContain("项目");
    expect(html).toContain("预算(万)");
    expect(html).toContain("云资源");
    expect(html).toContain("120");
    // Online mode offers quick link to live version
    expect(html).toContain('data-offline-viewer-online-btn=""');
    expect(html).toContain("前往在线版本");
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("renders cached doc list snapshot with offline-open links for individually cached entries", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <OfflineCacheViewer
          snapshot={listSnapshot}
          allSnapshots={[docSnapshot, sheetSnapshot]}
          onSelectSnapshot={() => {}}
          onClose={() => {}}
        />
      </I18nProvider>,
    );

    expect(html).toContain('data-offline-list-preview=""');
    expect(html).toContain("架构演进方案");
    expect(html).toContain("Q4 预算明细");
    expect(html).toContain("离线打开");
  });
});
