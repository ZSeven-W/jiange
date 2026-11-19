import { describe, expect, it } from "vitest";
import { buildFolderOptions, filterGlobalSearch, globalSearchState } from "./global-search";
import { SearchOpenGuard, searchKeyboardTarget } from "./global-search-actions";

const docs = [
  { id: 1, title: "文档", kind: "doc" as const, creatorId: 7, workspaceId: 1, parentId: null, icon: "", creatorName: "示例", createdAt: "2026-11-10T08:00:00Z", updatedAt: "2026-11-10T08:00:00Z" },
  { id: 2, title: "多维表格", kind: "base" as const, creatorId: 8, workspaceId: 1, parentId: null, icon: "", creatorName: "示例", createdAt: "2026-11-15T08:00:00Z", updatedAt: "2026-11-15T08:00:00Z" },
  { id: 3, title: "架构画板", kind: "doc" as const, docType: "board", creatorId: 7, workspaceId: 1, parentId: null, icon: "", creatorName: "示例", createdAt: "2026-11-18T08:00:00Z", updatedAt: "2026-11-18T08:00:00Z" },
  { id: 4, title: "财务报表", kind: "sheet" as const, creatorId: 7, workspaceId: 1, parentId: null, icon: "", creatorName: "示例", createdAt: "2026-11-19T08:00:00Z", updatedAt: "2026-11-19T08:00:00Z" },
  { id: 5, title: "客户问卷", kind: "survey" as const, creatorId: 7, workspaceId: 1, parentId: 10, icon: "", creatorName: "示例", createdAt: "2026-11-19T09:00:00Z", updatedAt: "2026-11-19T09:00:00Z" },
];
const ready = { isFetching: false, isPending: false, isError: false, fetchStatus: "idle", data: docs };

describe("global search authorization presentation", () => {
  it("hides previous search results while typing, refetching or offline", () => {
    expect(globalSearchState("新词", "旧词", ready, ready)).toEqual({ status: "loading", docs: [] });
    expect(globalSearchState("词", "词", ready, { ...ready, isFetching: true })).toEqual({ status: "loading", docs: [] });
    expect(globalSearchState("词", "词", ready, { ...ready, isError: true })).toEqual({ status: "error", docs: [] });
    expect(globalSearchState("词", "词", ready, { ...ready, fetchStatus: "paused" })).toEqual({ status: "error", docs: [] });
  });

  it("also hides recent documents during authorization revalidation or failure", () => {
    expect(globalSearchState("", "", { ...ready, isFetching: true }, ready)).toEqual({ status: "loading", docs: [] });
    expect(globalSearchState("", "", { ...ready, isError: true }, ready)).toEqual({ status: "error", docs: [] });
    expect(globalSearchState("", "", { ...ready, data: [] }, ready)).toEqual({ status: "empty", docs: [] });
  });

  it("uses server search query when path or date filters are active without a keyword", () => {
    const filteredOnly = { ...ready, data: [docs[4]] };
    expect(globalSearchState("", "", { ...ready, data: [] }, filteredOnly, true)).toEqual({ status: "ready", docs: [docs[4]] });
  });

  it("filters verified results by type, ownership, and exact date range without changing the source", () => {
    expect(filterGlobalSearch(docs, "doc", "mine", 7).map((d) => d.id)).toEqual([1]);
    expect(filterGlobalSearch(docs, "board", "mine", 7).map((d) => d.id)).toEqual([3]);
    expect(filterGlobalSearch(docs, "sheet", "mine", 7).map((d) => d.id)).toEqual([4]);
    expect(filterGlobalSearch(docs, "survey", "mine", 7).map((d) => d.id)).toEqual([5]);
    expect(filterGlobalSearch(docs, "base", "mine", 7)).toEqual([]);
    expect(filterGlobalSearch(docs, "all", "all", 7, 0, "2026-11-18", "2026-11-19").map((d) => d.id)).toEqual([3, 4, 5]);
    expect(filterGlobalSearch(docs, "all", "all", 7)).toEqual(docs);
    expect(docs).toHaveLength(5);
  });

  it("builds nested folder breadcrumb options for path filtering", () => {
    const folders = [
      { id: 10, title: "研发目录", kind: "folder" as const, creatorId: 7, workspaceId: 1, parentId: null, icon: "", creatorName: "示例", createdAt: "", updatedAt: "" },
      { id: 11, title: "核心专项", kind: "folder" as const, creatorId: 7, workspaceId: 1, parentId: 10, icon: "", creatorName: "示例", createdAt: "", updatedAt: "" },
      docs[0],
    ];
    expect(buildFolderOptions(folders)).toEqual([
      { id: 10, label: "研发目录" },
      { id: 11, label: "研发目录 / 核心专项" },
    ]);
  });
});

describe("search result actions", () => {
  it("navigates only the visible results and wraps keyboard selection", () => {
    expect(searchKeyboardTarget([], null, "Enter")).toBeNull();
    expect(searchKeyboardTarget([1, 2], null, "Enter")).toBe(1);
    expect(searchKeyboardTarget([1, 2], null, "ArrowUp")).toBe(2);
    expect(searchKeyboardTarget([1, 2], 2, "ArrowDown")).toBe(1);
    // A result removed by a new query cannot remain selected.
    expect(searchKeyboardTarget([2], 1, "Enter")).toBe(2);
  });

  it("ignores an access response after the search term or filter changes", async () => {
    const gate = new SearchOpenGuard();
    let resolve!: () => void;
    const response = new Promise<void>((done) => { resolve = done; });
    const first = gate.begin();
    expect(first).not.toBeNull();
    let navigated = false;
    const completion = response.then(() => { if (first !== null && gate.current(first)) navigated = true; });
    gate.invalidate(); // Changing the query or either filter changes user intent.
    const second = gate.begin();
    resolve();
    await completion;
    expect(navigated).toBe(false);
    expect(second).not.toBeNull();
    expect(second !== null && gate.current(second)).toBe(true);
    if (first !== null) gate.finish(first);
    expect(gate.begin()).toBeNull(); // An old response cannot unlock the new request.
    gate.dispose();
    expect(second !== null && gate.current(second)).toBe(false);
  });
});
