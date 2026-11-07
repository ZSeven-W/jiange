import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { baseApi, type Automation, type Field, type FilterRule, type User } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ask } from "@/components/ui/ask";

const OP_LABEL: Record<string, string> = {
  contains: "包含", not_contains: "不包含", is: "等于", is_not: "不等于",
  empty: "为空", not_empty: "不为空", gt: "大于", gte: "大于等于",
  lt: "小于", lte: "小于等于", checked: "已勾选", unchecked: "未勾选",
};

interface AutomationConfig {
  rules?: FilterRule[];
  conj?: "and" | "or";
  notifyUsers?: number[];
  message?: string;
  webhook?: { url?: string; kind?: string; message?: string };
  schedule?: { every?: string };
}

function opsFor(type: string): string[] {
  switch (type) {
    case "number": return ["is", "is_not", "gt", "gte", "lt", "lte", "empty", "not_empty"];
    case "checkbox": return ["checked", "unchecked"];
    default: return ["contains", "not_contains", "is", "is_not", "empty", "not_empty"];
  }
}

/** 自动化面板：触发器（表单提交/记录满足条件）→ 通知成员 + IM webhook。 */
export function AutomationsPanel({
  baseId,
  fields,
  members,
  onClose,
}: {
  baseId: number;
  fields: Field[];
  members: User[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const key = ["automations", baseId];
  const list = useQuery({ queryKey: key, queryFn: () => baseApi.automations(baseId) });
  const [editing, setEditing] = useState<Automation | null>(null);
  const [creating, setCreating] = useState(false);
  const invalidate = () => qc.invalidateQueries({ queryKey: key });
  const automations = list.data ?? [];

  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-full max-w-96 flex-col border-l bg-surface shadow-xl" data-automations-panel>
      <header className="flex h-[52px] shrink-0 items-center border-b px-4 text-[15px] font-semibold">
        自动化
        <button className="ml-auto rounded p-1 text-subtle hover:bg-hover hover:text-foreground" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-3">
        {creating ? (
          <AutomationForm baseId={baseId} fields={fields} members={members} onDone={() => { setCreating(false); invalidate(); }} onCancel={() => setCreating(false)} />
        ) : editing ? (
          <AutomationForm baseId={baseId} fields={fields} members={members} initial={editing} onDone={() => { setEditing(null); invalidate(); }} onCancel={() => setEditing(null)} />
        ) : (
          <>
            <button
              className="mb-3 h-8 w-full rounded-md bg-primary text-[13px] font-medium text-white hover:opacity-90"
              onClick={() => setCreating(true)}
              data-create-automation
            >
              + 新建自动化
            </button>
            {automations.length === 0 && <p className="px-2 py-8 text-center text-[13px] text-subtle">还没有自动化流程</p>}
            {automations.map((a) => (
              <div key={a.id} className="mb-2 rounded-lg border p-3 text-[13px]" data-automation={a.id}>
                <div className="flex items-center gap-2 font-medium">
                  <span className="truncate">{a.name}</span>
                  <span className={cn("ml-auto rounded px-1.5 py-0.5 text-[11px]", a.enabled ? "bg-[#D9F5D6] text-[#237B19] dark:bg-[#1d3a24] dark:text-[#7bd88f]" : "bg-hover text-subtle")}>
                    {a.enabled ? "已启用" : "已停用"}
                  </span>
                </div>
                <div className="mt-1 text-[12px] text-muted-foreground">
                  {a.triggerKind === "form_submit"
                    ? "表单提交时"
                    : a.triggerKind === "schedule"
                      ? `定时（每${(a.config as { schedule?: { every?: string } })?.schedule?.every === "1h" ? "小时" : (a.config as { schedule?: { every?: string } })?.schedule?.every === "1w" ? "周" : "天"}）`
                      : "记录满足条件时"}
                </div>
                <div className="mt-2 flex gap-2">
                  <button className="rounded border px-2 py-0.5 text-[12px] hover:bg-hover" onClick={() => setEditing(a)}>编辑</button>
                  <button
                    className="rounded border px-2 py-0.5 text-[12px] hover:bg-hover"
                    onClick={() => baseApi.updateAutomation(baseId, a.id, { enabled: !a.enabled }).then(invalidate)}
                  >
                    {a.enabled ? "停用" : "启用"}
                  </button>
                  <button
                    className="ml-auto text-[12px] text-destructive hover:underline"
                    onClick={() => void ask("删除该自动化？").then((ok: boolean) => { if (ok) void baseApi.deleteAutomation(baseId, a.id).then(invalidate); })}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </aside>
  );
}

function AutomationForm({
  baseId,
  fields,
  members,
  initial,
  onDone,
  onCancel,
}: {
  baseId: number;
  fields: Field[];
  members: User[];
  initial?: Automation;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [trigger, setTrigger] = useState(initial?.triggerKind ?? "record_matches");
  const [cfg, setCfg] = useState<AutomationConfig>(() => {
    try {
      return (initial?.config as unknown as AutomationConfig) ?? {};
    } catch {
      return {};
    }
  });
  const [busy, setBusy] = useState(false);
  const rules = cfg.rules ?? [];
  const notify = new Set(cfg.notifyUsers ?? []);

  const save = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    const payload = {
      name: name.trim(),
      triggerKind: trigger,
      enabled: initial?.enabled ?? true,
      config: {
        schedule: trigger === "schedule" ? cfg.schedule ?? { every: "1d" } : undefined,
        rules: trigger === "record_matches" ? rules : undefined,
        conj: rules.length > 1 ? cfg.conj ?? "and" : undefined,
        notifyUsers: [...notify],
        message: cfg.message ?? "",
        webhook: cfg.webhook?.url ? cfg.webhook : undefined,
      },
    };
    const res = initial
      ? await baseApi.updateAutomation(baseId, initial.id, payload).catch(() => null)
      : await baseApi.addAutomation(baseId, payload).catch(() => null);
    setBusy(false);
    if (res) onDone();
  };

  return (
    <div className="space-y-3 text-[13px]" data-automation-form>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="流程名称"
        className="h-8 w-full rounded-md border px-2 outline-none focus:border-primary"
        data-auto-name
      />
      <select
        className="h-8 w-full rounded-md border bg-surface px-2 outline-none focus:border-primary"
        value={trigger}
        onChange={(e) => setTrigger(e.target.value as Automation["triggerKind"])}
        data-auto-trigger
      >
        <option value="record_matches">当记录满足条件时</option>
        <option value="form_submit">当表单被提交时</option>
        <option value="schedule">定时触发</option>
      </select>
      {trigger === "schedule" && (
        <select
          className="h-8 w-full rounded-md border bg-surface px-2 outline-none focus:border-primary"
          value={cfg.schedule?.every ?? "1d"}
          onChange={(e) => setCfg({ ...cfg, schedule: { every: e.target.value } })}
          data-auto-every
        >
          <option value="1h">每小时</option>
          <option value="1d">每天</option>
          <option value="1w">每周</option>
        </select>
      )}
      {trigger === "record_matches" && (
        <div className="space-y-1.5 rounded-md border p-2" data-auto-rules>
          <p className="text-[12px] text-subtle">触发条件</p>
          {rules.map((rule, i) => {
            const f = fields.find((x) => x.id === rule.f) ?? fields[0];
            const noValue = rule.op === "empty" || rule.op === "not_empty" || rule.op === "checked" || rule.op === "unchecked";
            return (
              <div key={i} className="flex items-center gap-1">
                <select
                  className="h-7 w-20 rounded border bg-surface px-1"
                  value={rule.f}
                  onChange={(e) => {
                    const rules2 = [...rules];
                    rules2[i] = { ...rule, f: Number(e.target.value) };
                    setCfg({ ...cfg, rules: rules2 });
                  }}
                >
                  {fields.map((x) => (
                    <option key={x.id} value={x.id}>{x.name}</option>
                  ))}
                </select>
                <select
                  className="h-7 w-20 rounded border bg-surface px-1"
                  value={rule.op}
                  onChange={(e) => {
                    const rules2 = [...rules];
                    rules2[i] = { ...rule, op: e.target.value };
                    setCfg({ ...cfg, rules: rules2 });
                  }}
                >
                  {opsFor(f?.type ?? "text").map((op) => (
                    <option key={op} value={op}>{OP_LABEL[op]}</option>
                  ))}
                </select>
                {!noValue && (
                  <input
                    className="h-7 min-w-0 flex-1 rounded border px-1.5 outline-none focus:border-primary"
                    value={String(rule.v ?? "")}
                    onChange={(e) => {
                      const rules2 = [...rules];
                      rules2[i] = { ...rule, v: f?.type === "number" ? Number(e.target.value) : e.target.value };
                      setCfg({ ...cfg, rules: rules2 });
                    }}
                  />
                )}
                <button className="px-1 text-subtle hover:text-destructive" onClick={() => setCfg({ ...cfg, rules: rules.filter((_, j) => j !== i) })}>✕</button>
              </div>
            );
          })}
          <button
            className="text-[12px] text-primary hover:underline"
            onClick={() => setCfg({ ...cfg, rules: [...rules, { f: fields[0]?.id ?? 0, op: opsFor(fields[0]?.type ?? "text")[0], v: "" }] })}
          >
            + 添加条件
          </button>
        </div>
      )}
      <div className="rounded-md border p-2" data-auto-action>
        <p className="mb-1.5 text-[12px] text-subtle">通知这些成员</p>
        <div className="max-h-28 space-y-0.5 overflow-y-auto">
          {members.map((m) => (
            <label key={m.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-hover">
              <input
                type="checkbox"
                className="accent-primary"
                checked={notify.has(m.id)}
                onChange={(e) => {
                  const next = new Set(notify);
                  if (e.target.checked) next.add(m.id);
                  else next.delete(m.id);
                  setCfg({ ...cfg, notifyUsers: [...next] });
                }}
              />
              {m.name}
            </label>
          ))}
        </div>
        <input
          value={cfg.message ?? ""}
          onChange={(e) => setCfg({ ...cfg, message: e.target.value })}
          placeholder="通知消息，可用 {{字段名}} 插值"
          className="mt-1.5 h-8 w-full rounded border px-2 outline-none focus:border-primary"
          data-auto-message
        />
        <p className="mb-1.5 mt-2 text-[12px] text-subtle">推送到 IM 群机器人（企微/钉钉/飞书/自建，可选）</p>
        <select
          className="h-8 w-full rounded border bg-surface px-2 outline-none focus:border-primary"
          value={cfg.webhook?.kind ?? ""}
          onChange={(e) => setCfg({ ...cfg, webhook: { ...cfg.webhook, kind: e.target.value } })}
          data-auto-hook-kind
        >
          <option value="">不推送</option>
          <option value="wecom">企业微信</option>
          <option value="dingtalk">钉钉</option>
          <option value="feishu">飞书</option>
          <option value="generic">自建（通用 JSON）</option>
        </select>
        {cfg.webhook?.kind && (
          <>
            <input
              value={cfg.webhook.url ?? ""}
              onChange={(e) => setCfg({ ...cfg, webhook: { ...cfg.webhook, url: e.target.value } })}
              placeholder="Webhook URL"
              className="mt-1.5 h-8 w-full rounded border px-2 font-mono text-[12px] outline-none focus:border-primary"
              data-auto-hook-url
            />
            <input
              value={cfg.webhook.message ?? ""}
              onChange={(e) => setCfg({ ...cfg, webhook: { ...cfg.webhook, message: e.target.value } })}
              placeholder="推送消息，可用 {{字段名}}"
              className="mt-1.5 h-8 w-full rounded border px-2 outline-none focus:border-primary"
            />
          </>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <button className="h-8 rounded-md border px-3 text-[13px] hover:bg-hover" onClick={onCancel}>取消</button>
        <button className="h-8 rounded-md bg-primary px-3 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50" disabled={busy || !name.trim()} onClick={() => void save()} data-auto-save>
          {initial ? "保存" : "创建"}
        </button>
      </div>
    </div>
  );
}
