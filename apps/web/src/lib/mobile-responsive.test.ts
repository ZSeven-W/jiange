import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { DocMeta, DriveEntry, Me, SheetSnapshot, SlidesPage, WikiSpace, WikiSpaceDetail } from "@/lib/api";
import { Home } from "@/pages/home";
import { DrivePage } from "@/pages/drive-page";
import { DriveUploadManager } from "@/pages/drive-upload";
import { SheetPage } from "@/pages/sheet/sheet-page";
import { SlidesDeck } from "@/pages/slides-page";
import { WikiSpacesPage } from "@/pages/wiki/wiki-spaces-page";
import { WikiSpacePage } from "@/pages/wiki/wiki-space-page";

const srcDir = fileURLToPath(new URL("..", import.meta.url));
const readSrc = (relPath: string) => readFileSync(join(srcDir, relPath), "utf8");

const me: Me = {
  user: { id: 1, email: "mobile@example.test", name: "移动端测试", createdAt: "2026-11-20T00:00:00Z" },
  workspaces: [{ id: 10, name: "研发团队空间", ownerId: 1 }],
};

describe("Mobile responsive adaptation across the Jiange suite", () => {
  it("defines mobile CSS foundation rules in index.css without breaking desktop", () => {
    const css = readSrc("index.css");
    expect(css).toContain(".mobile-scroll-x");
    expect(css).toContain("-webkit-overflow-scrolling: touch");
    expect(css).toContain("scrollbar-width: none");
    expect(css).toContain(".mobile-scroll-x::-webkit-scrollbar");
    expect(css).toContain("@media (max-width: 768px)");
    expect(css).toContain("height: 100dvh");
    expect(css).toContain("env(safe-area-inset-bottom");
    expect(css).toContain("overflow-x: clip");
    expect(css).toContain("max-width: calc(100vw - 16px)");
    expect(css).toContain("[data-format-toolbar]");
    expect(css).toContain(":not([data-version-panel])");
  });

  it("configures App shell mobile drawer state, surface menu button, and Escape closing", () => {
    const appSrc = readSrc("app.tsx");
    expect(appSrc).toContain('data-mobile-nav-open={sidebarOpen ? "true" : "false"}');
    expect(appSrc).toContain("bg-surface/90");
    expect(appSrc).toContain("backdrop-blur-sm");
    expect(appSrc).toContain("md:bg-transparent");
    expect(appSrc).toContain("md:border-0");
    expect(appSrc).toContain("md:shadow-none");
    expect(appSrc).toContain("data-mobile-nav-backdrop");
    expect(appSrc).toContain('event.key !== "Escape"');
    expect(appSrc).toContain("closeSidebar()");
  });

  it("renders Home with mobile header offset, 2-col quick cards, mobile-scroll-x tabs, and compact mobile rows", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const doc: DocMeta = {
      id: 101,
      workspaceId: 10,
      parentId: null,
      title: "移动端适配方案",
      icon: "",
      creatorId: 1,
      creatorName: "移动端测试",
      createdAt: "2026-11-20T00:00:00Z",
      updatedAt: "2026-11-20T01:00:00Z",
      role: "manage",
      kind: "doc",
    };
    qc.setQueryData(["docs"], [doc]);
    qc.setQueryData(["recent", 1], [{ ...doc, viewedAt: "2026-11-20T01:00:00Z" }]);
    qc.setQueryData(["home-favorites", 1], []);
    qc.setQueryData(["home-pins", 1], []);

    const html = renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(Home, { me, uploads: new DriveUploadManager(1, () => {}) }),
      ),
    );
    expect(html).toContain("pl-14");
    expect(html).toContain("grid-cols-2");
    expect(html).toContain("mobile-scroll-x");
    expect(html).toContain("hidden truncate sm:block");
    expect(html).toContain("移动端适配方案");
  });

  it("renders DrivePage with mobile header offset, 2-col quick cards, scrollable tabs, and clean mobile metadata", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const entry: DriveEntry = {
      id: 201,
      workspaceId: 10,
      parentId: null,
      kind: "doc",
      title: "季度复盘",
      role: "manage",
      revision: 1,
      personal: true,
      creatorName: "移动端测试",
      updatedAt: "2026-11-20T01:00:00Z",
      createdAt: "2026-11-20T00:00:00Z",
    };
    qc.setQueryData(["drive", null, true], [entry]);
    qc.setQueryData(["drive-shortcuts", null, true], []);
    qc.setQueryData(["favorites"], []);

    const html = renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(DrivePage, { folderId: null, personalRoot: true, userId: 1, uploads: new DriveUploadManager(1, () => {}) }),
      ),
    );
    expect(html).toContain("pl-14");
    expect(html).toContain("grid-cols-2");
    expect(html).toContain("mobile-scroll-x");
    expect(html).toContain("block sm:hidden");
    expect(html).toContain("hidden sm:block md:hidden");
    expect(html).toContain("季度复盘");
    expect(readSrc("pages/drive-page.tsx")).toContain("hidden sm:block xl:hidden");
  });

  it("configures Cloud Doc mobile header, body padding, and side panel overlays", () => {
    const docSrc = readSrc("pages/doc-page.tsx");
    expect(docSrc).toContain("pl-14 pr-2");
    expect(docSrc).toContain("min-w-0 flex-1 truncate font-medium");
    expect(docSrc).toContain('className="hidden sm:inline">{label}');
    expect(docSrc).toContain("px-4 sm:px-16");
    expect(docSrc).toContain('data-doc-side-overlay="suggestions"');
    expect(docSrc).toContain("fixed inset-y-0 right-0 z-40 flex w-[min(100vw,360px)] shadow-xl md:static md:z-auto");
  });

  it("renders SheetPage and SheetToolbar with mobile-scroll-x toolbars, compact formula box, and side overlay", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const meta: DocMeta = {
      id: 301,
      workspaceId: 10,
      parentId: null,
      title: "年度预算表",
      icon: "",
      creatorId: 1,
      creatorName: "移动端测试",
      createdAt: "2026-11-20T00:00:00Z",
      updatedAt: "2026-11-20T01:00:00Z",
      role: "manage",
      kind: "sheet",
    };
    const snapshot: SheetSnapshot = {
      nodeId: 301,
      workspaceId: 10,
      parentId: null,
      title: "年度预算表",
      role: "manage",
      creatorId: 1,
      creatorName: "移动端测试",
      driveRevision: 1,
      workbookRevision: 1,
      updatedAt: "2026-11-20T01:00:00Z",
      sheets: [
        {
          id: 1,
          nodeId: 301,
          title: "Sheet1",
          pos: 0,
          frozenRows: 0,
          frozenCols: 0,
          merges: [],
          filter: {},
          validations: [],
          conditionalFormats: [],
          protectedRanges: [],
          revision: 1,
          rows: [{ id: 1, pos: 0 }],
          columns: [{ id: 1, pos: 0 }],
          cells: [],
        },
      ],
    };
    qc.setQueryData(["doc", 301, 1], meta);
    qc.setQueryData(["sheet-ancestors", 301, 1], []);
    qc.setQueryData(["home-pins", 1], []);
    qc.setQueryData(["sheet-comments", 301, 1], { comments: [] });
    qc.setQueryData(["sheet", 301, 1], snapshot);

    const html = renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(SheetPage, { sheetId: 301, me }),
      ),
    );
    expect(html).toContain("pl-14");
    expect(html).toContain("mobile-scroll-x");
    expect(html).toContain("w-12 shrink-0");
    expect(html).toContain("sm:w-16");
    expect(html).toContain("hidden sm:inline");

    const sheetSrc = readSrc("pages/sheet/sheet-page.tsx");
    expect(sheetSrc).toContain("data-sheet-panel-overlay");
    expect(sheetSrc).toContain("fixed inset-y-0 right-0 z-40 flex w-[min(100vw,360px)] shadow-xl md:static");
  });

  it("renders SlidesDeck with mobile horizontal filmstrip, scrollable toolbar, and format overlay", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const meta: DocMeta = {
      id: 401,
      workspaceId: 10,
      parentId: null,
      title: "产品发布会演示",
      icon: "",
      creatorId: 1,
      creatorName: "移动端测试",
      createdAt: "2026-11-20T00:00:00Z",
      updatedAt: "2026-11-20T01:00:00Z",
      role: "manage",
      kind: "slides",
    };
    const pages: SlidesPage[] = [
      {
        id: 11,
        slidesId: 401,
        pos: 1,
        title: "封面",
        body: "移动端适配",
        notes: "",
        background: "#ffffff",
        layout: "title",
        hidden: false,
        shapes: [],
        revision: 1,
        updatedAt: "2026-11-20T01:00:00Z",
      },
    ];
    qc.setQueryData(["slides-meta", 401, 1], meta);
    qc.setQueryData(["slides", 401, 1], pages);

    const html = renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(SlidesDeck, { deckId: 401, userId: 1 }),
      ),
    );
    expect(html).toContain("pl-14");
    expect(html).toContain("data-slides-toolbar");
    expect(html).toContain("mobile-scroll-x");
    expect(html).toContain("h-24 w-full shrink-0 flex-row");
    expect(html).toContain("md:h-auto md:w-[196px] md:flex-col");

    const slidesSrc = readSrc("pages/slides-page.tsx");
    expect(slidesSrc).toContain("data-slides-format-overlay");
    expect(slidesSrc).toContain("fixed inset-y-0 right-0 z-40 flex w-[min(100vw,360px)] shadow-xl md:static");
  });

  it("renders WikiSpacesPage and WikiSpacePage with responsive grid and mobile collapsible tree drawer", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const space: WikiSpace = {
      id: 7,
      workspaceId: 10,
      name: "移动端知识库",
      description: "响应式规范",
      icon: "📚",
      visibility: "workspace",
      creatorId: 1,
      creatorName: "移动端测试",
      callerRole: "manage",
      nodeCount: 1,
      createdAt: "2026-11-20T00:00:00Z",
      updatedAt: "2026-11-20T00:00:00Z",
    };
    qc.setQueryData(["wiki-spaces", 10, 1], [space]);

    const spacesHtml = renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(WikiSpacesPage, { me }),
      ),
    );
    expect(spacesHtml).toContain("pl-14");
    expect(spacesHtml).toContain("grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3");

    const detail: WikiSpaceDetail = {
      space,
      grants: [],
      nodes: [],
      shortcuts: [],
    };
    qc.setQueryData(["wiki-space", 7, 1], detail);
    const spaceHtml = renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(WikiSpacePage, { spaceId: 7, nodeId: null, me }),
      ),
    );
    expect(spaceHtml).toContain('data-wiki-tree-open="false"');
    expect(spaceHtml).toContain("data-wiki-open-tree");
    expect(spaceHtml).toContain("data-wiki-main-pane");
    expect(spaceHtml).toContain("h-14 shrink-0 items-center gap-2 border-b bg-surface px-3 pl-14 md:h-11 md:pl-3");

    const wikiSpaceSrc = readSrc("pages/wiki/wiki-space-page.tsx");
    expect(wikiSpaceSrc).toContain("data-wiki-tree-drawer");
    expect(wikiSpaceSrc).toContain('e.key === "Escape"');
  });

  it("does not introduce any native <select> elements in modified pages", () => {
    const ownedTsx = [
      "app.tsx",
      "pages/home.tsx",
      "pages/drive-page.tsx",
      "pages/doc-page.tsx",
      "pages/sheet/sheet-page.tsx",
      "pages/sheet/sheet-toolbar.tsx",
      "pages/slides-page.tsx",
      "pages/wiki/wiki-spaces-page.tsx",
      "pages/wiki/wiki-space-page.tsx",
    ];
    for (const rel of ownedTsx) {
      expect(readSrc(rel), `${rel} should not contain native <select>`).not.toMatch(/<select[\s>]/i);
    }
  });
});
