import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Automation, BaseTable, Field, User } from "@/lib/api";
import {
  AutomationForm,
  AutomationsPanel,
  buildAutomationPayload,
  countAutomationActions,
  createDefaultAction,
  normalizeInitialActions,
} from "./automations";

const fields: Field[] = [
  { id: 1, name: "标题", type: "text", position: 1, isPrimary: true },
  { id: 2, name: "状态", type: "select", options: ["待办", "进行中", "完成"], position: 2 },
  { id: 3, name: "金额", type: "number", position: 3 },
  { id: 4, name: "已审核", type: "checkbox", position: 4 },
  { id: 5, name: "计算值", type: "formula", formula: "[金额]*2", position: 5 },
];

const tables: BaseTable[] = [
  { id: 10, baseId: 1, name: "订单表", position: 1, isDefault: true },
  { id: 11, baseId: 1, name: "归档表", position: 2, isDefault: false },
];

const members: User[] = [
  { id: 1, name: "张三", email: "a@x.com", createdAt: "2026-01-01T00:00:00Z" },
  { id: 2, name: "李四", email: "b@x.com", createdAt: "2026-01-01T00:00:00Z" },
];

describe("Base Automations visual builder", () => {
  it("counts nested actions accurately across if/else branches", () => {
    const nested = [
      createDefaultAction("find_records", fields, 10),
      {
        id: "if-1",
        type: "if_condition" as const,
        conj: "and" as const,
        rules: [{ f: 3, op: "gte", v: 1000 }],
        thenActions: [
          createDefaultAction("update_record", fields),
          createDefaultAction("notify", fields),
        ],
        elseActions: [createDefaultAction("webhook", fields)],
      },
    ];
    expect(countAutomationActions(nested)).toBe(5);
  });

  it("migrates legacy top-level notifyUsers & webhook into editable actions cleanly", () => {
    const legacy = normalizeInitialActions({
      notifyUsers: [2],
      message: "状态已更新：{{状态}}",
      webhook: { kind: "feishu", url: "https://example.com/hook", message: "提醒" },
    });
    expect(legacy).toHaveLength(2);
    expect(legacy[0]).toMatchObject({ type: "notify", notifyUsers: [2], message: "状态已更新：{{状态}}" });
    expect(legacy[1]).toMatchObject({
      type: "webhook",
      webhook: { kind: "feishu", url: "https://example.com/hook", message: "提醒" },
    });
  });

  it("serializes multi-step actions and clears legacy notifyUsers to prevent double-firing", () => {
    const payload = buildAutomationPayload({
      name: "  完成归档流程  ",
      trigger: "record_matches",
      enabled: true,
      rules: [{ f: 2, op: "is", v: "完成" }],
      conj: "and",
      scheduleEvery: "1d",
      actions: [
        { id: "a1", type: "find_records", tableId: 10, conj: "and", rules: [{ f: 2, op: "is", v: "待办" }], limit: 99 },
        { id: "a2", type: "update_record", targetScope: "found", cells: { "2": "完成" } },
      ],
    });
    expect(payload.name).toBe("完成归档流程");
    expect(payload.config?.notifyUsers).toEqual([]);
    expect(payload.config?.actions).toHaveLength(2);
    expect(payload.config?.actions?.[0].limit).toBe(50); // clamped to backend limit 50
    expect(payload.config?.actions?.[1].targetScope).toBe("found");
  });

  it("renders all 6 action types with template variable hints and ZERO native <select> elements", () => {
    const initial: Automation = {
      id: 99,
      baseId: 1,
      name: "全功能工作流",
      enabled: true,
      triggerKind: "record_matches",
      config: {
        conj: "and",
        rules: [{ f: 2, op: "is", v: "完成" }],
        actions: [
          { id: "a1", type: "create_record", tableId: 11, cells: { "1": "{{base.title}} #{{record.id}}" } },
          { id: "a2", type: "find_records", tableId: 10, conj: "and", rules: [{ f: 3, op: "gt", v: 100 }], limit: 20 },
          { id: "a3", type: "update_record", targetScope: "found", cells: { "4": true } },
          {
            id: "a4",
            type: "if_condition",
            conj: "and",
            rules: [{ f: 3, op: "gte", v: 500 }],
            thenActions: [{ id: "a5", type: "notify", notifyUsers: [2], message: "高额订单 {{field:1}}" }],
            elseActions: [
              { id: "a6", type: "webhook", webhook: { kind: "feishu", url: "https://example.com/hook", message: "普通订单" } },
            ],
          },
        ],
      },
    };
    const html = renderToStaticMarkup(
      <AutomationForm
        baseId={1}
        fields={fields}
        tables={tables}
        activeTableId={10}
        members={members}
        initial={initial}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).not.toContain("<select");
    expect(html).toContain("执行动作");
    expect(html).toContain("新增记录");
    expect(html).toContain("查找记录");
    expect(html).toContain("修改记录");
    expect(html).toContain("条件分支 (如果/否则)");
    expect(html).toContain("如果满足（执行）");
    expect(html).toContain("否则（执行）");
    expect(html).toContain("发送站内通知");
    expect(html).toContain("推送群机器人 Webhook");
    expect(html).toContain("{{field:1}}");
    expect(html).toContain("{{record.id}}");
    expect(html).toContain("{{base.title}}");
    expect(html).toContain("{{found.count}}");
    expect(html).toContain("6/10");
  });

  it("renders AutomationsPanel shell cleanly without native select", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <AutomationsPanel baseId={1} fields={fields} tables={tables} members={members} onClose={() => {}} />
      </QueryClientProvider>,
    );
    expect(html).toContain("data-automations-panel");
    expect(html).toContain("+ 新建自动化");
    expect(html).not.toContain("<select");
  });
});
