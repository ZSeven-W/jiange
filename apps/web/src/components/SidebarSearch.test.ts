import { describe, expect, it } from "vitest";
import { sidebarSearchState } from "./Sidebar";

const result = [{ id: 1, title: "旧搜索结果" }];
const success = { isFetching: false, isPending: false, isError: false, fetchStatus: "idle", data: result };

describe("sidebar search presentation", () => {
  it("hides previous results immediately while a new keyword is being debounced", () => {
    expect(sidebarSearchState("新词", "旧词", success)).toEqual({ status: "loading", docs: [] });
    expect(sidebarSearchState("", "旧词", success)).toEqual({ status: "idle", docs: [] });
  });

  it("does not expose cached results during a permission recheck or after a failed request", () => {
    expect(sidebarSearchState("词", "词", { ...success, isFetching: true })).toEqual({ status: "loading", docs: [] });
    expect(sidebarSearchState("词", "词", { ...success, isError: true })).toEqual({ status: "error", docs: [] });
    expect(sidebarSearchState("词", "词", { ...success, fetchStatus: "paused" })).toEqual({ status: "error", docs: [] });
  });

  it("distinguishes a verified empty response from an error", () => {
    expect(sidebarSearchState("词", "词", { ...success, data: [] })).toEqual({ status: "empty", docs: [] });
    expect(sidebarSearchState("词", "词", success)).toEqual({ status: "ready", docs: result });
  });
});
