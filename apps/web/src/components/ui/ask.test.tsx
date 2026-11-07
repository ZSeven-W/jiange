import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AskHost, _askVersion, ask, askArea, askText, cancelOutstandingAsks, subscribeAskHost } from "./ask";

afterEach(cancelOutstandingAsks);

describe("dialogs during session changes", () => {
  it("cancels pending decisions and removes their sensitive content", async () => {
    const confirm = ask("旧账号私有文档");
    const prompt = askText("重命名", "名称", "旧账号私有标题");
    const area = askArea("旧账号内容", "", "私有草稿");
    cancelOutstandingAsks();
    await expect(confirm).resolves.toBe(false);
    await expect(prompt).resolves.toBeNull();
    await expect(area).resolves.toBeNull();
    expect(renderToStaticMarkup(<AskHost />)).toBe("");
  });

  it("does not accidentally confirm an old rename when a new session opens a dialog", async () => {
    const old = askText("旧账号", "名称", "旧标题");
    cancelOutstandingAsks();
    await expect(old).resolves.toBeNull();
    const next = askText("新账号", "名称", "新标题");
    const html = renderToStaticMarkup(<AskHost />);
    expect(html).toContain("新标题");
    expect(html).not.toContain("旧标题");
    cancelOutstandingAsks();
    await expect(next).resolves.toBeNull();
  });

  it("cancels on host unmount and notifies a new host rendered before cleanup", async () => {
    const disposeOld = subscribeAskHost(vi.fn(), _askVersion());
    const old = askText("旧账号", "名称", "旧账号私有标题");
    // React may render the new host before running the old host's cleanup.
    const newRenderVersion = _askVersion();
    expect(renderToStaticMarkup(<AskHost />)).toContain("旧账号私有标题");
    disposeOld();
    const notifyNew = vi.fn();
    const disposeNew = subscribeAskHost(notifyNew, newRenderVersion);
    expect(notifyNew).toHaveBeenCalledOnce();
    await expect(old).resolves.toBeNull();
    expect(renderToStaticMarkup(<AskHost />)).toBe("");
    disposeNew();
  });
});
