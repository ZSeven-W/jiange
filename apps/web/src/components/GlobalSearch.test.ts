import { describe, expect, it } from "vitest";
import { filterGlobalSearch, globalSearchState } from "./GlobalSearch";
import { SearchOpenGuard, searchKeyboardTarget } from "./globalSearchActions";

const docs = [
  { id: 1, title: "文档", kind: "doc" as const, creatorId: 7, workspaceId: 1, parentId: null, icon: "", creatorName: "示例", createdAt: "", updatedAt: "" },
  { id: 2, title: "表格", kind: "base" as const, creatorId: 8, workspaceId: 1, parentId: null, icon: "", creatorName: "示例", createdAt: "", updatedAt: "" },
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

  it("filters verified results by type and ownership without changing the source", () => {
    expect(filterGlobalSearch(docs, "doc", "mine", 7).map((d) => d.id)).toEqual([1]);
    expect(filterGlobalSearch(docs, "base", "mine", 7)).toEqual([]);
    expect(filterGlobalSearch(docs, "all", "all", 7)).toEqual(docs);
    expect(docs).toHaveLength(2);
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
