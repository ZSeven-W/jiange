import { afterEach, expect, it, vi } from "vitest";
import { baseApi } from "@/lib/api";

afterEach(() => vi.unstubAllGlobals());

it("binds both the post-create snapshot and view creation to the initiating account", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  await baseApi.getForAccount(7, 3, controller.signal);
  await baseApi.addViewForAccount(7, 3, { type: "grid", name: "表格视图" });
  expect(fetch.mock.calls[0][0]).toBe("/api/bases/7/account-snapshot");
  expect(fetch.mock.calls[0][1]).toMatchObject({ headers: { "X-Jiange-User-Id": "3" }, signal: controller.signal });
  expect(fetch.mock.calls[1][0]).toBe("/api/bases/7/account-views");
  expect(fetch.mock.calls[1][1]).toMatchObject({ method: "POST", headers: { "X-Jiange-User-Id": "3" } });
});
