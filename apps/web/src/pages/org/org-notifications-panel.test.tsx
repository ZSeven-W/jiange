import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_CHANNEL_EVENTS,
  type NotificationChannel,
} from "@/lib/notification-channels-api";
import { OrgNotificationsPanel, parseRecipientsList } from "./org-notifications-panel";

const sampleFeishuChannel: NotificationChannel = {
  id: 21,
  workspaceId: 10,
  name: "研发飞书通知群",
  kind: "feishu_bot",
  configHint: "open.feishu.cn/...8f2a (已加签)",
  events: ["mention", "comment_reply", "automation"],
  enabled: true,
  lastStatus: "ok",
  lastError: "",
  lastSentAt: "2026-11-24T08:15:00Z",
  createdAt: "2026-11-24T06:00:00Z",
  updatedAt: "2026-11-24T08:15:00Z",
};

const sampleSMTPChannel: NotificationChannel = {
  id: 22,
  workspaceId: 10,
  name: "运维告警邮箱",
  kind: "smtp",
  configHint: "smtp.corp.example.com:587 -> al***@corp.example.com (+1)",
  events: ["automation", "share_updated"],
  enabled: false,
  lastStatus: "error",
  lastError: "dial tcp: timeout",
  lastSentAt: "2026-11-24T07:00:00Z",
  createdAt: "2026-11-24T05:00:00Z",
  updatedAt: "2026-11-24T07:00:00Z",
};

describe("OrgNotificationsPanel", () => {
  it("blocks regular workspace members with an informational guard and zero native selects", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <OrgNotificationsPanel workspaceId={10} userId={2} canAdmin={false} />
      </QueryClientProvider>,
    );
    expect(html).toContain("仅空间所有者或管理员可管理外部通知渠道");
    expect(html).not.toContain("data-notif-channel-create-btn");
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("renders channel cards with masked config hints, switches, events, test buttons, and inline status badges", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(
      ["workspace-notification-channels", 10, 1],
      [sampleFeishuChannel, sampleSMTPChannel],
    );
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <OrgNotificationsPanel
          workspaceId={10}
          userId={1}
          canAdmin={true}
          initialTestResults={{
            21: {
              ok: true,
              status: "ok",
              error: "",
              latencyMs: 85,
              sentAt: "2026-11-24T09:00:00Z",
            },
          }}
        />
      </QueryClientProvider>,
    );
    expect(html).toContain("研发飞书通知群");
    expect(html).toContain("飞书群机器人");
    expect(html).toContain("open.feishu.cn/...8f2a (已加签)");
    expect(html).toContain("运维告警邮箱");
    expect(html).toContain("邮件 SMTP");
    expect(html).toContain("smtp.corp.example.com:587 -&gt; al***@corp.example.com (+1)");
    expect(html).toContain("被 @提及");
    expect(html).toContain("评论回复");
    expect(html).toContain("多维表自动化触发");
    expect(html).toContain("分享权限变更");
    expect(html).toContain("发送测试");
    expect(html).toContain("发送成功");
    expect(html).toContain("85 ms");
    expect(html).toContain("最近投递失败");
    expect(html).toContain("dial tcp: timeout");
    expect(html).toContain('role="switch"');
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("renders bot modal with FeishuSelect kind picker, bot webhook/secret fields, all 4 event checkboxes, and zero native selects", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["workspace-notification-channels", 10, 1], []);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <OrgNotificationsPanel
          workspaceId={10}
          userId={1}
          canAdmin={true}
          initialEditorOpen={true}
          initialKind="feishu_bot"
        />
      </QueryClientProvider>,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain("新建通知渠道");
    expect(html).toContain("data-notif-channel-kind-select");
    expect(html).toContain('role="combobox"');
    expect(html).toContain("邮件 SMTP");
    expect(html).toContain("飞书群机器人");
    expect(html).toContain("钉钉群机器人");
    expect(html).toContain("企业微信机器人");
    expect(html).toContain("Slack Webhook");
    expect(html).toContain("data-notif-bot-fields");
    expect(html).toContain("data-notif-bot-url-input");
    expect(html).toContain("data-notif-bot-secret-input");
    for (const ev of NOTIFICATION_CHANNEL_EVENTS) {
      expect(html).toContain(`data-notif-channel-event-checkbox="${ev}"`);
    }
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("renders dynamic SMTP fields when SMTP kind is selected", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["workspace-notification-channels", 10, 1], []);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <OrgNotificationsPanel
          workspaceId={10}
          userId={1}
          canAdmin={true}
          initialEditorOpen={true}
          initialKind="smtp"
        />
      </QueryClientProvider>,
    );
    expect(html).toContain("data-notif-smtp-fields");
    expect(html).toContain("data-notif-smtp-host-input");
    expect(html).toContain("data-notif-smtp-port-input");
    expect(html).toContain("data-notif-smtp-user-input");
    expect(html).toContain("data-notif-smtp-pass-input");
    expect(html).toContain("data-notif-smtp-from-input");
    expect(html).toContain("data-notif-smtp-to-input");
    expect(html).toContain("data-notif-smtp-tls-checkbox");
    expect(html).not.toContain("data-notif-bot-fields");
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("renders edit modal with masked config hint notice and omits secret field for Slack/WeCom", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const slackChannel: NotificationChannel = {
      ...sampleFeishuChannel,
      id: 23,
      name: "Slack Alerts",
      kind: "slack_bot",
      configHint: "hooks.slack.com/...9999",
    };
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <OrgNotificationsPanel
          workspaceId={10}
          userId={1}
          canAdmin={true}
          initialEditingChannel={slackChannel}
        />
      </QueryClientProvider>,
    );
    expect(html).toContain("编辑通知渠道");
    expect(html).toContain("hooks.slack.com/...9999");
    expect(html).toContain("data-notif-bot-url-input");
    expect(html).not.toContain("data-notif-bot-secret-input");
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("splits comma, Chinese comma, semicolon, and newline separated SMTP recipients cleanly", () => {
    expect(
      parseRecipientsList("alice@example.com, bob@example.com，carol@example.com\ndave@example.com; "),
    ).toEqual([
      "alice@example.com",
      "bob@example.com",
      "carol@example.com",
      "dave@example.com",
    ]);
  });
});
