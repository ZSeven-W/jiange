import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import type { OfflineStateHookValue } from "@/lib/offline-sync";
import { OfflineBanner, OfflineCacheButton, PwaInstallButton } from "./offline-banner";

describe("OfflineBanner", () => {
  it("renders nothing in normal online state (zero visual clutter)", () => {
    expect(renderToStaticMarkup(<OfflineBanner />)).toBe("");
    expect(
      renderToStaticMarkup(
        <I18nProvider>
          <OfflineBanner status={{ online: true, justReconnected: false }} />
        </I18nProvider>,
      ),
    ).toBe("");
  });

  it("renders the Feishu amber offline pill with role=status when disconnected", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <OfflineBanner status={{ online: false, justReconnected: false }} />
      </I18nProvider>,
    );

    expect(html).toContain('data-offline-banner=""');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("网络已断开，本地草稿已暂存，恢复联网后将自动同步");
    expect(html).not.toContain("data-reconnected-banner");
    expect(html).toContain("bg-[#fff7e6]/95");
    expect(html).toContain("border-[#ffd591]");
    expect(html).toContain("pointer-events-none");
    expect(html).toContain("print:hidden");
  });

  it("renders the green reconnected confirmation pill when justReconnected is true", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <OfflineBanner status={{ online: true, justReconnected: true }} />
      </I18nProvider>,
    );

    expect(html).toContain('data-reconnected-banner=""');
    expect(html).toContain('role="status"');
    expect(html).toContain("网络已恢复，正在同步最新内容");
    expect(html).not.toContain("data-offline-banner");
    expect(html).toContain("bg-[#f6ffed]/95");
    expect(html).toContain("border-[#b7eb8f]");
  });

  it("supports top and bottom floating positions", () => {
    const bottomHtml = renderToStaticMarkup(
      <OfflineBanner status={{ online: false, justReconnected: false }} />,
    );
    const topHtml = renderToStaticMarkup(
      <OfflineBanner status={{ online: false, justReconnected: false }} position="top" />,
    );

    expect(bottomHtml).toContain("bottom-4");
    expect(topHtml).toContain("top-3");
  });

  it("shows cached count, pending queue count, disabled sync button when offline, and cache drawer trigger", () => {
    const offlineState: OfflineStateHookValue = {
      online: false,
      cachedSnapshots: [
        { key: "doc:1", kind: "doc", resourceId: 1, title: "需求文档", data: {}, updatedAt: 1000, sizeBytes: 512 },
        { key: "sheet:2", kind: "sheet", resourceId: 2, title: "排期表", data: {}, updatedAt: 2000, sizeBytes: 1024 },
      ],
      pendingQueue: [
        {
          id: "mut_1",
          resourceType: "doc",
          resourceId: 1,
          title: "重命名",
          method: "PATCH",
          path: "/api/docs/1",
          createdAt: 3000,
          retries: 0,
        },
      ],
      syncing: false,
      lastSyncSummary: null,
      syncNow: vi.fn(async () => ({ synced: 0, failed: 0, remaining: 1, completedAt: 0 })),
      removeSnapshot: vi.fn(async () => {}),
      clearCache: vi.fn(async () => {}),
      removeQueuedItem: vi.fn(async () => {}),
    };

    const html = renderToStaticMarkup(
      <I18nProvider>
        <OfflineBanner
          status={{ online: false, justReconnected: false }}
          offlineState={offlineState}
        />
      </I18nProvider>,
    );

    expect(html).toContain('data-offline-banner=""');
    expect(html).toContain("已缓存 2 项可离线查看");
    expect(html).toContain("待同步 1 条修改");
    expect(html).toContain('data-offline-sync-btn=""');
    expect(html).toMatch(/data-offline-sync-btn=""[^>]*\sdisabled=""/);
    expect(html).toContain('data-offline-drawer-btn=""');
    expect(html).toContain("离线缓存");
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("shows pending sync bar with enabled sync button when online and queue has pending mutations", () => {
    const offlineState: OfflineStateHookValue = {
      online: true,
      cachedSnapshots: [
        { key: "doc:1", kind: "doc", resourceId: 1, title: "需求文档", data: {}, updatedAt: 1000, sizeBytes: 512 },
      ],
      pendingQueue: [
        {
          id: "mut_1",
          resourceType: "doc",
          resourceId: 1,
          title: "重命名",
          method: "PATCH",
          path: "/api/docs/1",
          createdAt: 3000,
          retries: 0,
        },
        {
          id: "mut_2",
          resourceType: "sheet",
          resourceId: 2,
          title: "更新表格",
          method: "POST",
          path: "/api/sheets/2/cells",
          createdAt: 3001,
          retries: 0,
        },
      ],
      syncing: false,
      lastSyncSummary: null,
      syncNow: vi.fn(async () => ({ synced: 2, failed: 0, remaining: 0, completedAt: 0 })),
      removeSnapshot: vi.fn(async () => {}),
      clearCache: vi.fn(async () => {}),
      removeQueuedItem: vi.fn(async () => {}),
    };

    const html = renderToStaticMarkup(
      <I18nProvider>
        <OfflineBanner
          status={{ online: true, justReconnected: false }}
          offlineState={offlineState}
          initialDrawerOpen
        />
      </I18nProvider>,
    );

    expect(html).toContain('data-offline-banner=""');
    expect(html).toContain('data-offline-pending-banner=""');
    expect(html).toContain("待同步 2 条修改");
    expect(html).toContain("已缓存 1 项可离线查看");
    expect(html).toContain('data-offline-sync-btn=""');
    expect(html).not.toMatch(/data-offline-sync-btn=""[^>]*\sdisabled=""/);
    expect(html).toContain('data-offline-drawer-btn=""');
    expect(html).toContain('data-offline-cache-drawer=""');
    expect(html).not.toMatch(/<select[\s>]/i);
  });
});

describe("OfflineCacheButton", () => {
  it("renders compact trigger button with cached and pending count indicators", () => {
    const cachedOnlyHtml = renderToStaticMarkup(
      <I18nProvider>
        <OfflineCacheButton
          compact
          offlineState={{
            online: true,
            cachedSnapshots: [
              { key: "doc:1", kind: "doc", resourceId: 1, title: "A", data: {}, updatedAt: 1, sizeBytes: 10 },
            ],
            pendingQueue: [],
          }}
        />
      </I18nProvider>,
    );
    expect(cachedOnlyHtml).toContain('data-offline-cache-button=""');
    expect(cachedOnlyHtml).toContain("离线缓存");
    expect(cachedOnlyHtml).toContain('data-offline-cache-button-count="1"');

    const pendingHtml = renderToStaticMarkup(
      <I18nProvider>
        <OfflineCacheButton
          offlineState={{
            online: false,
            cachedSnapshots: [],
            pendingQueue: [
              {
                id: "m1",
                resourceType: "doc",
                title: "B",
                method: "PATCH",
                path: "/api/docs/1",
                createdAt: 1,
                retries: 0,
              },
            ],
          }}
        />
      </I18nProvider>,
    );
    expect(pendingHtml).toContain('data-offline-cache-button-pending="1"');
    expect(pendingHtml).toContain("bg-[#fff7e6]");
  });
});

describe("PwaInstallButton", () => {
  it("renders nothing when PWA installation is not available", () => {
    expect(renderToStaticMarkup(<PwaInstallButton />)).toBe("");
    expect(
      renderToStaticMarkup(
        <PwaInstallButton
          installPrompt={{
            canInstall: false,
            promptInstall: vi.fn(async () => "unavailable" as const),
            dismiss: vi.fn(),
          }}
        />,
      ),
    ).toBe("");
  });

  it("renders the compact Feishu-blue install pill when canInstall is true", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <PwaInstallButton
          installPrompt={{
            canInstall: true,
            promptInstall: vi.fn(async () => "accepted" as const),
            dismiss: vi.fn(),
          }}
        />
      </I18nProvider>,
    );

    expect(html).toContain('data-pwa-install-button=""');
    expect(html).toContain('data-pwa-install-trigger=""');
    expect(html).toContain('data-pwa-install-dismiss=""');
    expect(html).toContain("安装应用");
    expect(html).toContain("将 Jiange 安装到设备");
    expect(html).toContain("关闭安装提示");
    expect(html).toContain("#3370ff");
  });

  it("supports non-dismissible compact variant", () => {
    const html = renderToStaticMarkup(
      <PwaInstallButton
        compact
        dismissible={false}
        installPrompt={{
          canInstall: true,
          promptInstall: vi.fn(async () => "accepted" as const),
          dismiss: vi.fn(),
        }}
      />,
    );

    expect(html).toContain('data-pwa-install-trigger=""');
    expect(html).not.toContain("data-pwa-install-dismiss");
    expect(html).toContain("px-2.5 py-1 text-[12px]");
  });
});
