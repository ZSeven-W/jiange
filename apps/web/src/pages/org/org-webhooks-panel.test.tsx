import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WebhookDelivery, WorkspaceWebhook } from "@/lib/webhooks-api";
import {
  formatWebhookSecretHint,
  OrgWebhooksPanel,
  WEBHOOK_EVENT_OPTIONS,
} from "./org-webhooks-panel";

const sampleWebhook: WorkspaceWebhook = {
  id: 12,
  workspaceId: 10,
  name: "Enterprise Event Bus",
  url: "https://hooks.example.com/jiange/events",
  hasSecret: true,
  secretHint: "abcd",
  events: ["doc.created", "share.updated", "base.record_mutated"],
  enabled: true,
  createdAt: "2026-11-24T06:00:00Z",
  updatedAt: "2026-11-24T06:00:00Z",
};

const sampleDeliveries: WebhookDelivery[] = [
  {
    id: 102,
    webhookId: 12,
    workspaceId: 10,
    eventType: "doc.created",
    payload: { event: "doc.created", data: { docId: 42 } },
    statusCode: 200,
    responseBody: '{"received":true}',
    attempt: 3,
    success: true,
    errorMsg: "",
    createdAt: "2026-11-24T07:30:00Z",
  },
  {
    id: 101,
    webhookId: 12,
    workspaceId: 10,
    eventType: "webhook.test",
    payload: { event: "webhook.test" },
    statusCode: 503,
    responseBody: "upstream overloaded",
    attempt: 1,
    success: false,
    errorMsg: "HTTP 503 Service Unavailable",
    createdAt: "2026-11-24T07:20:00Z",
  },
];

describe("OrgWebhooksPanel", () => {
  it("blocks regular workspace members with an informational guard", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <OrgWebhooksPanel workspaceId={10} userId={2} canAdmin={false} />
      </QueryClientProvider>,
    );
    expect(html).toContain("仅空间所有者或管理员可配置空间事件 Webhook");
    expect(html).not.toContain("data-webhook-create-btn");
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("renders webhook cards with switch, URL, event chips, secret hint, inline test result, and zero native selects", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["workspace-webhooks", 10, 1], [sampleWebhook]);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <OrgWebhooksPanel
          workspaceId={10}
          userId={1}
          canAdmin={true}
          initialTestResults={{
            12: {
              delivery: sampleDeliveries[0],
              latencyMs: 42,
            },
          }}
        />
      </QueryClientProvider>,
    );
    expect(html).toContain("Enterprise Event Bus");
    expect(html).toContain("https://hooks.example.com/jiange/events");
    expect(html).toContain("****abcd");
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("文档创建");
    expect(html).toContain("权限与分享变更");
    expect(html).toContain("多维表记录变更");
    expect(html).toContain("发送测试事件");
    expect(html).toContain("投递记录");
    expect(html).toContain("HTTP 200");
    expect(html).toContain("42 ms");
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("renders one-time copyable signing secret banner after creation", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["workspace-webhooks", 10, 1], [sampleWebhook]);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <OrgWebhooksPanel
          workspaceId={10}
          userId={1}
          canAdmin={true}
          initialCreatedSecret={{
            webhookName: "Enterprise Event Bus",
            secret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          }}
        />
      </QueryClientProvider>,
    );
    expect(html).toContain("data-webhook-secret-banner");
    expect(html).toContain("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    expect(html).toContain("data-webhook-copy-secret");
    expect(html).toContain("HMAC-SHA256");
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("renders expanded delivery audit table with status badge, attempts, error, and response preview", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["workspace-webhooks", 10, 1], [sampleWebhook]);
    qc.setQueryData(["workspace-webhook-deliveries", 10, 12, 1], sampleDeliveries);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <OrgWebhooksPanel
          workspaceId={10}
          userId={1}
          canAdmin={true}
          initialExpandedWebhookId={12}
        />
      </QueryClientProvider>,
    );
    expect(html).toContain('data-webhook-deliveries-drawer="12"');
    expect(html).toContain('data-webhook-deliveries-table="12"');
    expect(html).toContain("HTTP 200");
    expect(html).toContain("第 3 次");
    expect(html).toContain("HTTP 503");
    expect(html).toContain("HTTP 503 Service Unavailable");
    expect(html).toContain("upstream overloaded");
    expect(html).toContain("测试事件");
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("renders create modal with all 6 event subscription checkboxes and zero native selects", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["workspace-webhooks", 10, 1], []);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <OrgWebhooksPanel
          workspaceId={10}
          userId={1}
          canAdmin={true}
          initialEditorOpen={true}
        />
      </QueryClientProvider>,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain("新建 Webhook");
    expect(html).toContain("留空将自动生成 32 字节随机签名密钥（推荐）");
    expect(WEBHOOK_EVENT_OPTIONS).toHaveLength(6);
    for (const opt of WEBHOOK_EVENT_OPTIONS) {
      expect(html).toContain(`data-webhook-event-checkbox="${opt.type}"`);
    }
    expect(html).toContain("文档创建");
    expect(html).toContain("文档删除");
    expect(html).toContain("权限与分享变更");
    expect(html).toContain("多维表记录变更");
    expect(html).toContain("电子表格编辑");
    expect(html).toContain("幻灯片版本创建");
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("renders edit modal with masked secret hint and regenerate option", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["workspace-webhooks", 10, 1], [sampleWebhook]);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <OrgWebhooksPanel
          workspaceId={10}
          userId={1}
          canAdmin={true}
          initialEditingWebhook={sampleWebhook}
        />
      </QueryClientProvider>,
    );
    expect(html).toContain("编辑 Webhook");
    expect(html).toContain('value="Enterprise Event Bus"');
    expect(html).toContain("已配置（****abcd），留空保持不变");
    expect(html).toContain("data-webhook-regenerate-secret");
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("formats webhook secret hints cleanly without double prefixing", () => {
    expect(formatWebhookSecretHint("abcd")).toBe("****abcd");
    expect(formatWebhookSecretHint("****abcd")).toBe("****abcd");
    expect(formatWebhookSecretHint("")).toBe("****");
  });
});
