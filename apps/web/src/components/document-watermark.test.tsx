import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WorkspaceSecurityPolicy } from "@/lib/enterprise-api";
import {
  DocumentWatermark,
  formatWatermarkLabel,
  workspaceSecurityPolicyQueryKey,
} from "./document-watermark";

const enabledPolicy: WorkspaceSecurityPolicy = {
  workspaceId: 10,
  watermarkEnabled: true,
  watermarkText: "内部机密",
  watermarkShowUser: true,
  watermarkShowEmail: true,
  watermarkShowDate: true,
  watermarkOpacity: 0.12,
  updatedBy: 1,
  updatedAt: "2026-11-24T00:00:00Z",
};

describe("formatWatermarkLabel", () => {
  it("returns null when neither workspace policy nor copyProtected is enabled", () => {
    expect(formatWatermarkLabel({ userName: "张三", userEmail: "zs@corp.com" })).toBeNull();
    expect(
      formatWatermarkLabel({
        policy: { ...enabledPolicy, watermarkEnabled: false },
        userName: "张三",
        userEmail: "zs@corp.com",
        copyProtected: false,
      }),
    ).toBeNull();
  });

  it("combines prefix text, user name, email, and YYYY-MM-DD date when policy is enabled", () => {
    const label = formatWatermarkLabel({
      policy: enabledPolicy,
      userName: "林晓",
      userEmail: "linxiao@corp.com",
      date: new Date("2026-11-24T00:00:00Z"),
    });
    expect(label).toBe("内部机密 · 林晓 · linxiao@corp.com · 2026-11-24");
  });

  it("respects individual visibility toggles and customText override", () => {
    const label = formatWatermarkLabel({
      policy: {
        ...enabledPolicy,
        watermarkShowUser: false,
        watermarkShowEmail: true,
        watermarkShowDate: false,
      },
      userName: "林晓",
      userEmail: "linxiao@corp.com",
      customText: "仅供审阅",
      date: "2026-11-24",
    });
    expect(label).toBe("仅供审阅 · linxiao@corp.com");
  });

  it("falls back to userName or 机密文档 when all policy segments are empty", () => {
    const emptyPolicy = {
      ...enabledPolicy,
      watermarkText: "",
      watermarkShowUser: false,
      watermarkShowEmail: false,
      watermarkShowDate: false,
    };
    expect(formatWatermarkLabel({ policy: emptyPolicy, userName: "陈明" })).toBe("陈明");
    expect(formatWatermarkLabel({ policy: emptyPolicy })).toBe("机密文档");
  });

  it("falls back cleanly when copyProtected is true without workspace watermark policy", () => {
    expect(
      formatWatermarkLabel({
        copyProtected: true,
        userName: "周瑶",
        userEmail: "zhouyao@corp.com",
      }),
    ).toBe("周瑶 zhouyao@corp.com");
    expect(formatWatermarkLabel({ copyProtected: true })).toBe("机密文档");
  });
});

describe("DocumentWatermark", () => {
  it("renders nothing when disabled and not copy-protected", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(workspaceSecurityPolicyQueryKey(10), { ...enabledPolicy, watermarkEnabled: false });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <DocumentWatermark workspaceId={10} userName="林晓" userEmail="linxiao@corp.com" />
      </QueryClientProvider>,
    );
    expect(html).toBe("");
  });

  it("renders full-viewport tiled SVG watermark from workspace security policy", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(workspaceSecurityPolicyQueryKey(10), enabledPolicy);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <DocumentWatermark
          workspaceId={10}
          userName="林晓"
          userEmail="linxiao@corp.com"
          date="2026-11-24"
        />
      </QueryClientProvider>,
    );
    expect(html).toContain("pointer-events-none fixed inset-0 z-50 select-none overflow-hidden");
    expect(html).toContain('data-watermark=""');
    expect(html).toContain('data-watermark-source="policy"');
    expect(html).toContain('data-watermark-opacity="0.12"');
    expect(html).toContain("内部机密 · 林晓 · linxiao@corp.com · 2026-11-24");
    expect(html).toContain("rotate(-24)");
    expect(html).toContain("dark:text-[#e8eaed]");
  });

  it("renders copy-protected watermark source when policy is disabled", () => {
    const html = renderToStaticMarkup(
      <DocumentWatermark
        policy={{ ...enabledPolicy, watermarkEnabled: false }}
        copyProtected={true}
        userName="周瑶"
        userEmail="zhouyao@corp.com"
      />,
    );
    expect(html).toContain('data-watermark-source="copy-protected"');
    expect(html).toContain('data-watermark-opacity="0.07"');
    expect(html).toContain("周瑶 zhouyao@corp.com");
  });

  it("supports contained preview mode and clamps out-of-range opacity", () => {
    const html = renderToStaticMarkup(
      <DocumentWatermark
        policy={{ ...enabledPolicy, watermarkOpacity: 0.9 }}
        userName="林晓"
        userEmail="linxiao@corp.com"
        date="2026-11-24"
        contained
      />,
    );
    expect(html).toContain("pointer-events-none absolute inset-0 z-10 select-none overflow-hidden");
    expect(html).toContain('data-watermark-opacity="0.25"');
  });
});
