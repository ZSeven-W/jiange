import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHash } from "@/lib/route";
import { PublicDocMessage } from "./public-doc";

describe("public document error actions", () => {
  it("keeps a login-only share token in the join route", () => {
    const token = "a1b2c3d4";
    const html = renderToStaticMarkup(<PublicDocMessage issue="login" token={token} onRetry={() => {}} />);
    expect(html).toContain(`href="#/s/${token}"`);
    expect(parseHash(`#/s/${token}`)).toEqual({ page: "join", token });
    expect(html).not.toContain("#/login");
  });

  it("shows retry for temporary failure and no login action for expired links", () => {
    const retry = renderToStaticMarkup(<PublicDocMessage issue="temporary" token="abc" onRetry={() => {}} />);
    const expired = renderToStaticMarkup(<PublicDocMessage issue="expired" token="abc" onRetry={() => {}} />);
    expect(retry).toContain("重试");
    expect(expired).toContain("链接已失效或已关闭分享");
    expect(expired).not.toContain("#/s/abc");
    const unsupported = renderToStaticMarkup(<PublicDocMessage issue="unsupported_table" token="abc" onRetry={() => {}} />);
    expect(unsupported).toContain("无法安全显示此文档中的表格内容");
    expect(unsupported).not.toContain("暂时无法连接服务器");
    const tableUnavailable = renderToStaticMarkup(<PublicDocMessage issue="table_unavailable" token="abc" onRetry={() => {}} />);
    expect(tableUnavailable).toContain("表格数据暂时无法安全显示");
    expect(tableUnavailable).toContain("重试");
  });
});
