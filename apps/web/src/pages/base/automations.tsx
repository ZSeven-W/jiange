import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  baseApi,
  type Automation,
  type AutomationAction,
  type AutomationActionType,
  type BaseTable,
  type Field,
  type FilterRule,
  type User,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { ask } from "@/components/ui/ask";
import { FeishuSelect } from "@/components/feishu-select";
import { MemberRuleValue, personRuleValue } from "./member-rule-value";
import { REGISTRY } from "./registry";
import { useI18n } from "@/lib/i18n";
import { ArrowDown, ArrowUp, Bell, FilePlus2, GitBranch, Pencil, Plus, Search, Send, Trash2, Zap } from "lucide-react";

const OP_LABEL: Record<string, string> = {
  contains: "包含",
  not_contains: "不包含",
  is: "等于",
  is_not: "不等于",
  empty: "为空",
  not_empty: "不为空",
  gt: "大于",
  gte: "大于等于",
  lt: "小于",
  lte: "小于等于",
  checked: "已勾选",
  unchecked: "未勾选",
};

export const MAX_AUTOMATION_ACTIONS = 10;
export const MAX_IF_DEPTH = 2;

const ACTION_META: Record<
  AutomationActionType,
  { label: string; desc: string; badgeClass: string; icon: typeof Zap }
> = {
  create_record: {
    label: "新增记录",
    desc: "在目标数据表中新增一条记录",
    badgeClass: "bg-[#e8f3ff] text-[#245bdb] dark:bg-[#1e3252] dark:text-[#8ab4ff]",
    icon: FilePlus2,
  },
  update_record: {
    label: "修改记录",
    desc: "更新触发记录或查找到的记录字段",
    badgeClass: "bg-[#e8f7e8] text-[#237b19] dark:bg-[#1d3a24] dark:text-[#7bd88f]",
    icon: Pencil,
  },
  find_records: {
    label: "查找记录",
    desc: "按条件筛选最多 50 条记录供后续步骤使用",
    badgeClass: "bg-[#fff4e5] text-[#b24d00] dark:bg-[#3f2c14] dark:text-[#ffc37a]",
    icon: Search,
  },
  if_condition: {
    label: "条件分支 (如果/否则)",
    desc: "根据触发记录条件走不同分支动作",
    badgeClass: "bg-[#f3ecff] text-[#6d3bd8] dark:bg-[#2d2148] dark:text-[#c7a8ff]",
    icon: GitBranch,
  },
  notify: {
    label: "发送站内通知",
    desc: "向指定协作成员发送站内提醒",
    badgeClass: "bg-[#e6f7f8] text-[#0c7a85] dark:bg-[#15393d] dark:text-[#7be3ec]",
    icon: Bell,
  },
  webhook: {
    label: "推送群机器人 Webhook",
    desc: "推送到企微 / 钉钉 / 飞书或自建入口",
    badgeClass: "bg-[#fceef5] text-[#b8286f] dark:bg-[#411d30] dark:text-[#ff9acc]",
    icon: Send,
  },
};

const ACTION_ORDER: AutomationActionType[] = [
  "create_record",
  "update_record",
  "find_records",
  "if_condition",
  "notify",
  "webhook",
];

function opsFor(type: string): string[] {
  switch (type) {
    case "number":
    case "rating":
      return ["is", "is_not", "gt", "gte", "lt", "lte", "empty", "not_empty"];
    case "checkbox":
      return ["checked", "unchecked"];
    default:
      return ["contains", "not_contains", "is", "is_not", "empty", "not_empty"];
  }
}

function writableFields(fields: Field[]): Field[] {
  return fields.filter(
    (f) =>
      !REGISTRY[f.type]?.readonly &&
      f.type !== "formula" &&
      f.type !== "link" &&
      f.type !== "lookup" &&
      f.type !== "attachment",
  );
}

/** 人员字段：切换字段/运算符时把值规范化为成员 id（数组或单个）。 */
const normalized = (f: Field | undefined, rule: FilterRule): FilterRule =>
  f?.type === "person" ? { ...rule, v: personRuleValue(rule.op, rule.v) } : rule;

let nextActionSeq = 1;
function genActionId(): string {
  nextActionSeq += 1;
  return `act_${Date.now().toString(36)}_${nextActionSeq}`;
}

/** Counts total actions recursively across top-level and nested if/else branches. */
export function countAutomationActions(actions: readonly AutomationAction[]): number {
  let total = 0;
  for (const act of actions) {
    total += 1;
    if (act.type === "if_condition") {
      total += countAutomationActions(act.thenActions ?? []);
      total += countAutomationActions(act.elseActions ?? []);
    }
  }
  return total;
}

/** Creates a well-formed default action for the visual builder. */
export function createDefaultAction(
  type: AutomationActionType,
  fields: Field[],
  activeTableId?: number,
): AutomationAction {
  const id = genActionId();
  const writable = writableFields(fields);
  const firstWritable = writable[0];
  const firstField = fields[0];
  switch (type) {
    case "create_record":
      return {
        id,
        type,
        tableId: activeTableId,
        cells: firstWritable ? { [String(firstWritable.id)]: "" } : {},
      };
    case "update_record":
      return {
        id,
        type,
        targetScope: "trigger",
        cells: firstWritable ? { [String(firstWritable.id)]: "" } : {},
      };
    case "find_records":
      return {
        id,
        type,
        tableId: activeTableId,
        conj: "and",
        limit: 20,
        rules: firstField
          ? [
              firstField.type === "person"
                ? { f: firstField.id, op: "contains", v: [] }
                : { f: firstField.id, op: opsFor(firstField.type)[0], v: "" },
            ]
          : [],
      };
    case "if_condition":
      return {
        id,
        type,
        conj: "and",
        rules: firstField
          ? [
              firstField.type === "person"
                ? { f: firstField.id, op: "contains", v: [] }
                : { f: firstField.id, op: opsFor(firstField.type)[0], v: "" },
            ]
          : [],
        thenActions: [],
        elseActions: [],
      };
    case "notify":
      return {
        id,
        type,
        notifyUsers: [],
        message: "",
      };
    case "webhook":
      return {
        id,
        type,
        webhook: { kind: "feishu", url: "", message: "" },
      };
  }
}

/**
 * Loads structured actions from a saved automation config.
 * Legacy automations that only had top-level notifyUsers/webhook are surfaced
 * as editable notify/webhook steps so they upgrade cleanly without double-firing.
 */
export function normalizeInitialActions(config?: Automation["config"]): AutomationAction[] {
  if (!config) return [];
  if (config.actions && config.actions.length > 0) {
    return config.actions.map((a) => ({ ...a, id: a.id || genActionId() }));
  }
  const migrated: AutomationAction[] = [];
  if ((config.notifyUsers?.length ?? 0) > 0 || (config.message ?? "").trim()) {
    migrated.push({
      id: genActionId(),
      type: "notify",
      notifyUsers: [...(config.notifyUsers ?? [])],
      message: config.message ?? "",
    });
  }
  if (config.webhook?.url) {
    migrated.push({
      id: genActionId(),
      type: "webhook",
      webhook: { ...config.webhook },
    });
  }
  return migrated;
}

function sanitizeAction(act: AutomationAction): AutomationAction {
  const base: AutomationAction = { id: act.id || genActionId(), type: act.type };
  switch (act.type) {
    case "create_record":
      return {
        ...base,
        ...(act.tableId ? { tableId: act.tableId } : {}),
        cells: act.cells ?? {},
      };
    case "update_record":
      return {
        ...base,
        targetScope: act.targetScope === "found" ? "found" : "trigger",
        cells: act.cells ?? {},
      };
    case "find_records":
      return {
        ...base,
        ...(act.tableId ? { tableId: act.tableId } : {}),
        conj: act.conj === "or" ? "or" : "and",
        rules: act.rules ?? [],
        limit: Math.min(50, Math.max(1, Number(act.limit) || 20)),
      };
    case "if_condition":
      return {
        ...base,
        conj: act.conj === "or" ? "or" : "and",
        rules: act.rules ?? [],
        thenActions: (act.thenActions ?? []).map(sanitizeAction),
        elseActions: (act.elseActions ?? []).map(sanitizeAction),
      };
    case "notify":
      return {
        ...base,
        notifyUsers: [...(act.notifyUsers ?? [])],
        message: act.message ?? "",
      };
    case "webhook":
      return {
        ...base,
        webhook: {
          kind: act.webhook?.kind || "generic",
          url: (act.webhook?.url ?? "").trim(),
          message: act.webhook?.message ?? act.message ?? "",
        },
      };
  }
}

export function buildAutomationPayload({
  name,
  trigger,
  enabled,
  rules,
  conj,
  scheduleEvery,
  actions,
}: {
  name: string;
  trigger: Automation["triggerKind"];
  enabled: boolean;
  rules: FilterRule[];
  conj: "and" | "or";
  scheduleEvery: string;
  actions: AutomationAction[];
}): Partial<Automation> {
  const cleanActions = actions.map(sanitizeAction);
  return {
    name: name.trim(),
    triggerKind: trigger,
    enabled,
    config: {
      schedule: trigger === "schedule" ? { every: scheduleEvery || "1d" } : undefined,
      rules: trigger === "record_matches" || (trigger === "schedule" && rules.length > 0) ? rules : undefined,
      conj: rules.length > 1 ? conj : undefined,
      notifyUsers: [],
      actions: cleanActions.length > 0 ? cleanActions : undefined,
    },
  };
}

/** 自动化面板：飞书式多步骤工作流构建器（触发器 → 查找/读写记录/条件分支/通知/Webhook）。 */
export function AutomationsPanel({
  baseId,
  fields,
  tables = [],
  activeTableId,
  members,
  onClose,
}: {
  baseId: number;
  fields: Field[];
  tables?: BaseTable[];
  activeTableId?: number;
  members: User[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const key = ["automations", baseId];
  const list = useQuery({ queryKey: key, queryFn: () => baseApi.automations(baseId) });
  const [editing, setEditing] = useState<Automation | null>(null);
  const [creating, setCreating] = useState(false);
  const invalidate = () => qc.invalidateQueries({ queryKey: key });
  const automations = list.data ?? [];

  return (
    <aside
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[480px] flex-col border-l bg-surface shadow-xl"
      data-automations-panel
    >
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b px-4 text-[15px] font-semibold">
        <Zap size={16} className="text-primary" />
        <span>{t("自动化")}</span>
        <button
          type="button"
          className="ml-auto rounded p-1 text-subtle hover:bg-hover hover:text-foreground"
          onClick={onClose}
          aria-label={t("关闭")}
        >
          ✕
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-3.5">
        {creating ? (
          <AutomationForm
            baseId={baseId}
            fields={fields}
            tables={tables}
            activeTableId={activeTableId}
            members={members}
            onDone={() => {
              setCreating(false);
              void invalidate();
            }}
            onCancel={() => setCreating(false)}
          />
        ) : editing ? (
          <AutomationForm
            baseId={baseId}
            fields={fields}
            tables={tables}
            activeTableId={activeTableId}
            members={members}
            initial={editing}
            onDone={() => {
              setEditing(null);
              void invalidate();
            }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <>
            <button
              type="button"
              className="mb-3 flex h-8 w-full items-center justify-center gap-1 rounded-md bg-primary text-[13px] font-medium text-white hover:opacity-90"
              onClick={() => setCreating(true)}
              data-create-automation
            >
              {t("+ 新建自动化")}
            </button>
            {automations.length === 0 && (
              <p className="px-2 py-8 text-center text-[13px] text-subtle">{t("还没有自动化流程")}</p>
            )}
            {automations.map((a) => {
              const stepCount = countAutomationActions(normalizeInitialActions(a.config));
              return (
                <div key={a.id} className="mb-2.5 rounded-lg border p-3 text-[13px]" data-automation={a.id}>
                  <div className="flex items-center gap-2 font-medium">
                    <span className="truncate">{a.name}</span>
                    <span
                      className={cn(
                        "ml-auto shrink-0 rounded px-1.5 py-0.5 text-[11px]",
                        a.enabled
                          ? "bg-[#D9F5D6] text-[#237B19] dark:bg-[#1d3a24] dark:text-[#7bd88f]"
                          : "bg-hover text-subtle",
                      )}
                    >
                      {a.enabled ? t("已启用") : t("已停用")}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[12px] text-muted-foreground">
                    <span>
                      {a.triggerKind === "form_submit"
                        ? t("表单提交时")
                        : a.triggerKind === "schedule"
                          ? t("定时（每{unit}）", {
                              unit:
                                a.config?.schedule?.every === "1h"
                                  ? t("小时")
                                  : a.config?.schedule?.every === "1w"
                                    ? t("周")
                                    : t("天"),
                            })
                          : t("记录满足条件时")}
                    </span>
                    {stepCount > 0 && (
                      <span className="rounded bg-accent px-1.5 py-0.5 text-[11px] text-primary">
                        {t("{n} 个动作", { n: stepCount })}
                      </span>
                    )}
                  </div>
                  <div className="mt-2.5 flex gap-2">
                    <button
                      type="button"
                      className="rounded border px-2 py-0.5 text-[12px] hover:bg-hover"
                      onClick={() => setEditing(a)}
                    >
                      {t("编辑")}
                    </button>
                    <button
                      type="button"
                      className="rounded border px-2 py-0.5 text-[12px] hover:bg-hover"
                      onClick={() =>
                        void baseApi.updateAutomation(baseId, a.id, { enabled: !a.enabled }).then(invalidate)
                      }
                    >
                      {a.enabled ? t("停用") : t("启用")}
                    </button>
                    <button
                      type="button"
                      className="ml-auto text-[12px] text-destructive hover:underline"
                      onClick={() =>
                        void ask(t("删除该自动化？")).then((ok: boolean) => {
                          if (ok) void baseApi.deleteAutomation(baseId, a.id).then(invalidate);
                        })
                      }
                    >
                      {t("删除")}
                    </button>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
    </aside>
  );
}

export function AutomationForm({
  baseId,
  fields,
  tables = [],
  activeTableId,
  members,
  initial,
  onDone,
  onCancel,
}: {
  baseId: number;
  fields: Field[];
  tables?: BaseTable[];
  activeTableId?: number;
  members: User[];
  initial?: Automation;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initial?.name ?? "");
  const [trigger, setTrigger] = useState<Automation["triggerKind"]>(initial?.triggerKind ?? "record_matches");
  const [rules, setRules] = useState<FilterRule[]>(() => initial?.config?.rules ?? []);
  const [conj, setConj] = useState<"and" | "or">(initial?.config?.conj ?? "and");
  const [scheduleEvery, setScheduleEvery] = useState(initial?.config?.schedule?.every ?? "1d");
  const [actions, setActions] = useState<AutomationAction[]>(() => normalizeInitialActions(initial?.config));
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const totalActions = countAutomationActions(actions);

  const save = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setErrorMsg(null);
    const payload = buildAutomationPayload({
      name,
      trigger,
      enabled: initial?.enabled ?? true,
      rules,
      conj,
      scheduleEvery,
      actions,
    });
    try {
      const res = initial
        ? await baseApi.updateAutomation(baseId, initial.id, payload)
        : await baseApi.addAutomation(baseId, payload);
      if (res) onDone();
    } catch (err) {
      setErrorMsg(err instanceof ApiError ? err.message : t("保存自动化失败，请检查配置后重试。"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 text-[13px]" data-automation-form>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t("流程名称")}
        className="h-8 w-full rounded-md border px-2.5 outline-none focus:border-primary"
        data-auto-name
      />

      {/* 步骤 1：触发器 */}
      <section className="rounded-lg border bg-surface p-3 shadow-2xs" data-auto-trigger-card>
        <div className="mb-2 flex items-center gap-2">
          <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-semibold text-white">
            1
          </span>
          <span className="font-medium text-foreground">{t("触发条件")}</span>
        </div>
        <div className="space-y-2">
          <FeishuSelect
            ariaLabel={t("触发方式")}
            className="h-8 w-full border border-[#dee0e3] bg-surface px-2 text-[13px]"
            value={trigger}
            options={[
              { value: "record_matches", label: t("当记录满足条件时") },
              { value: "form_submit", label: t("当表单被提交时") },
              { value: "schedule", label: t("定时触发") },
            ]}
            onChange={(val) => setTrigger(val as Automation["triggerKind"])}
            dataAttr={{ "data-auto-trigger": true }}
          />
          {trigger === "schedule" && (
            <FeishuSelect
              ariaLabel={t("定时频率")}
              className="h-8 w-full border border-[#dee0e3] bg-surface px-2 text-[13px]"
              value={scheduleEvery}
              options={[
                { value: "1h", label: t("每小时") },
                { value: "1d", label: t("每天") },
                { value: "1w", label: t("每周") },
              ]}
              onChange={(val) => setScheduleEvery(val)}
              dataAttr={{ "data-auto-every": true }}
            />
          )}
          {(trigger === "record_matches" || trigger === "schedule") && (
            <div className="rounded-md border border-dashed bg-sidebar/40 p-2" data-auto-rules>
              <RuleListEditor
                label={trigger === "schedule" ? t("筛选满足条件的记录（可选）") : t("满足以下条件时触发")}
                fields={fields}
                members={members}
                rules={rules}
                conj={conj}
                onChange={(nextRules, nextConj) => {
                  setRules(nextRules);
                  setConj(nextConj);
                }}
              />
            </div>
          )}
        </div>
      </section>

      {/* 连接线 */}
      <div className="flex justify-center" aria-hidden>
        <span className="h-3 w-px bg-border" />
      </div>

      {/* 步骤 2：执行动作 */}
      <section className="rounded-lg border bg-surface p-3 shadow-2xs" data-auto-actions>
        <div className="mb-2 flex items-center gap-2">
          <span className="grid size-5 shrink-0 place-items-center rounded-full bg-[#237b19] text-[11px] font-semibold text-white">
            2
          </span>
          <span className="font-medium text-foreground">{t("执行动作")}</span>
          <span className="ml-auto text-[11px] text-subtle">
            {totalActions}/{MAX_AUTOMATION_ACTIONS}
          </span>
        </div>
        <ActionListEditor
          actions={actions}
          depth={0}
          totalCount={totalActions}
          fields={fields}
          tables={tables}
          activeTableId={activeTableId}
          members={members}
          onChange={setActions}
        />
      </section>

      {errorMsg && (
        <p role="alert" className="rounded-md bg-destructive/10 px-2.5 py-1.5 text-[12px] text-destructive">
          {errorMsg}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          className="h-8 rounded-md border px-3 text-[13px] hover:bg-hover"
          onClick={onCancel}
        >
          {t("取消")}
        </button>
        <button
          type="button"
          className="h-8 rounded-md bg-primary px-3 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50"
          disabled={busy || !name.trim() || totalActions > MAX_AUTOMATION_ACTIONS}
          onClick={() => void save()}
          data-auto-save
        >
          {initial ? t("保存") : t("创建")}
        </button>
      </div>
    </div>
  );
}

function RuleListEditor({
  label,
  fields,
  members,
  rules,
  conj,
  onChange,
}: {
  label: string;
  fields: Field[];
  members: User[];
  rules: FilterRule[];
  conj: "and" | "or";
  onChange: (rules: FilterRule[], conj: "and" | "or") => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] text-subtle">{label}</span>
        {rules.length > 1 && (
          <FeishuSelect
            ariaLabel={t("条件组合")}
            className="h-6 border border-[#dee0e3] bg-surface px-1.5 text-[11px]"
            chevronSize={10}
            menuMinWidth={112}
            value={conj}
            options={[
              { value: "and", label: t("全部满足（且）") },
              { value: "or", label: t("任一满足（或）") },
            ]}
            onChange={(val) => onChange(rules, val === "or" ? "or" : "and")}
          />
        )}
      </div>
      {rules.map((rule, i) => {
        const f = fields.find((x) => x.id === rule.f) ?? fields[0];
        const noValue =
          rule.op === "empty" ||
          rule.op === "not_empty" ||
          rule.op === "checked" ||
          rule.op === "unchecked";
        return (
          <div key={i} className="flex items-center gap-1">
            <FeishuSelect
              ariaLabel={t("筛选字段")}
              className="h-7 w-24 shrink-0 border border-[#dee0e3] bg-surface px-1.5 text-[12px]"
              chevronSize={11}
              menuMinWidth={116}
              value={String(rule.f)}
              options={fields.map((x) => ({ value: String(x.id), label: x.name }))}
              onChange={(val) => {
                const nf = fields.find((x) => x.id === Number(val));
                const next = [...rules];
                next[i] = normalized(nf, { ...rule, f: Number(val), op: opsFor(nf?.type ?? "text")[0] });
                onChange(next, conj);
              }}
            />
            <FeishuSelect
              ariaLabel={t("筛选条件")}
              className="h-7 w-20 shrink-0 border border-[#dee0e3] bg-surface px-1 text-[12px]"
              chevronSize={11}
              menuMinWidth={104}
              value={rule.op}
              options={opsFor(f?.type ?? "text").map((op) => ({ value: op, label: t(OP_LABEL[op]) }))}
              onChange={(val) => {
                const next = [...rules];
                next[i] = normalized(f, { ...rule, op: val });
                onChange(next, conj);
              }}
            />
            {!noValue &&
              (f?.type === "person" ? (
                <MemberRuleValue
                  rule={rule}
                  members={members}
                  onChange={(v) => {
                    const next = [...rules];
                    next[i] = { ...rule, v };
                    onChange(next, conj);
                  }}
                />
              ) : (
                <input
                  className="h-7 min-w-0 flex-1 rounded border bg-surface px-1.5 text-[12px] outline-none focus:border-primary"
                  placeholder={t("值或 {{field:...}}")}
                  value={String(rule.v ?? "")}
                  onChange={(e) => {
                    const raw = e.target.value;
                    const next = [...rules];
                    const isTemplate = raw.includes("{{");
                    next[i] = {
                      ...rule,
                      v: !isTemplate && (f?.type === "number" || f?.type === "rating") && raw !== "" && !Number.isNaN(Number(raw))
                        ? Number(raw)
                        : raw,
                    };
                    onChange(next, conj);
                  }}
                />
              ))}
            <button
              type="button"
              aria-label={t("移除条件")}
              className="px-1 text-subtle hover:text-destructive"
              onClick={() => onChange(rules.filter((_, j) => j !== i), conj)}
            >
              ✕
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="text-[12px] text-primary hover:underline"
        onClick={() => {
          const nf = fields[0];
          if (!nf) return;
          onChange(
            [
              ...rules,
              nf.type === "person"
                ? { f: nf.id, op: "contains", v: [] }
                : { f: nf.id, op: opsFor(nf.type)[0], v: "" },
            ],
            conj,
          );
        }}
      >
        {t("+ 添加条件")}
      </button>
    </div>
  );
}

function CellAssignmentsEditor({
  fields,
  allTriggerFields,
  cells,
  onChange,
  showFoundVar,
}: {
  fields: Field[];
  allTriggerFields: Field[];
  cells: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  showFoundVar?: boolean;
}) {
  const { t } = useI18n();
  const writable = writableFields(fields);
  const entries = Object.entries(cells);
  const [focusedKey, setFocusedKey] = useState<string | null>(entries[0]?.[0] ?? null);

  const setKeyValue = (oldKey: string, newKey: string, val: unknown) => {
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cells)) {
      if (k === oldKey) next[newKey] = val;
      else next[k] = v;
    }
    onChange(next);
  };

  const removeKey = (key: string) => {
    const next = { ...cells };
    delete next[key];
    onChange(next);
  };

  const addRow = () => {
    const unused = writable.find((f) => !(String(f.id) in cells)) ?? writable[0];
    if (!unused) return;
    const key = String(unused.id);
    onChange({ ...cells, [key]: unused.type === "checkbox" ? true : "" });
    setFocusedKey(key);
  };

  const insertToken = (token: string) => {
    const targetKey = (focusedKey && focusedKey in cells ? focusedKey : entries[entries.length - 1]?.[0]) ?? null;
    if (!targetKey) return;
    const cur = cells[targetKey];
    onChange({ ...cells, [targetKey]: `${cur === undefined || cur === null ? "" : String(cur)}${token}` });
  };

  return (
    <div className="space-y-1.5" data-cell-assignments>
      <span className="block text-[12px] text-subtle">{t("设置字段值")}</span>
      {entries.map(([fidStr, rawVal], idx) => {
        const field = writable.find((f) => String(f.id) === fidStr) ?? writable[0];
        const fieldOpts = writable.map((f) => ({ value: String(f.id), label: f.name }));
        return (
          <div key={`${fidStr}-${idx}`} className="flex items-center gap-1.5">
            <FeishuSelect
              ariaLabel={t("目标字段")}
              className="h-7 w-28 shrink-0 border border-[#dee0e3] bg-surface px-1.5 text-[12px]"
              chevronSize={11}
              menuMinWidth={124}
              value={fidStr}
              options={fieldOpts.length ? fieldOpts : [{ value: fidStr, label: `#${fidStr}` }]}
              onChange={(val) => {
                setKeyValue(fidStr, val, rawVal);
                setFocusedKey(val);
              }}
            />
            {field?.type === "checkbox" ? (
              <FeishuSelect
                ariaLabel={t("字段值")}
                className="h-7 min-w-0 flex-1 border border-[#dee0e3] bg-surface px-1.5 text-[12px]"
                chevronSize={11}
                menuMinWidth={100}
                value={rawVal === true || rawVal === "true" ? "true" : "false"}
                options={[
                  { value: "true", label: t("已勾选") },
                  { value: "false", label: t("未勾选") },
                ]}
                onChange={(val) => onChange({ ...cells, [fidStr]: val === "true" })}
              />
            ) : field?.type === "select" && (field.options?.length ?? 0) > 0 && !String(rawVal ?? "").includes("{{") ? (
              <FeishuSelect
                ariaLabel={t("字段值")}
                className="h-7 min-w-0 flex-1 border border-[#dee0e3] bg-surface px-1.5 text-[12px]"
                chevronSize={11}
                menuMinWidth={120}
                value={String(rawVal ?? "")}
                options={[
                  { value: "", label: t("选择选项") },
                  ...(field.options ?? []).map((o) => ({ value: o, label: o })),
                ]}
                onChange={(val) => onChange({ ...cells, [fidStr]: val })}
              />
            ) : (
              <input
                className="h-7 min-w-0 flex-1 rounded border bg-surface px-2 text-[12px] outline-none focus:border-primary"
                value={rawVal === null || rawVal === undefined ? "" : String(rawVal)}
                placeholder={t("输入值或 {{field:字段ID}}")}
                onFocus={() => setFocusedKey(fidStr)}
                onChange={(e) => onChange({ ...cells, [fidStr]: e.target.value })}
              />
            )}
            <button
              type="button"
              aria-label={t("删除字段赋值")}
              className="px-1 text-subtle hover:text-destructive"
              onClick={() => removeKey(fidStr)}
            >
              ✕
            </button>
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        <button
          type="button"
          className="text-[12px] text-primary hover:underline"
          onClick={addRow}
          disabled={writable.length === 0}
        >
          {t("+ 添加字段赋值")}
        </button>
      </div>
      <div className="rounded bg-sidebar/60 px-2 py-1.5 text-[11px] text-subtle" data-template-hint>
        <span>{t("支持模板变量：")}</span>
        <span className="mt-1 flex flex-wrap gap-1">
          {allTriggerFields.slice(0, 4).map((f) => (
            <button
              key={f.id}
              type="button"
              className="rounded border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:border-primary hover:text-primary"
              onClick={() => insertToken(`{{field:${f.id}}}`)}
              title={f.name}
            >
              {`{{field:${f.id}}}`}
            </button>
          ))}
          <button
            type="button"
            className="rounded border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:border-primary hover:text-primary"
            onClick={() => insertToken("{{record.id}}")}
          >
            {"{{record.id}}"}
          </button>
          <button
            type="button"
            className="rounded border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:border-primary hover:text-primary"
            onClick={() => insertToken("{{base.title}}")}
          >
            {"{{base.title}}"}
          </button>
          {showFoundVar && (
            <button
              type="button"
              className="rounded border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:border-primary hover:text-primary"
              onClick={() => insertToken("{{found.count}}")}
            >
              {"{{found.count}}"}
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

function ActionListEditor({
  actions,
  depth,
  totalCount,
  fields,
  tables,
  activeTableId,
  members,
  onChange,
}: {
  actions: AutomationAction[];
  depth: number;
  totalCount: number;
  fields: Field[];
  tables: BaseTable[];
  activeTableId?: number;
  members: User[];
  onChange: (next: AutomationAction[]) => void;
}) {
  const { t } = useI18n();
  const [pickerOpen, setPickerOpen] = useState(false);

  const updateAt = (index: number, patch: Partial<AutomationAction>) => {
    onChange(actions.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  const removeAt = (index: number) => {
    onChange(actions.filter((_, i) => i !== index));
  };

  const moveAt = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= actions.length) return;
    const copy = [...actions];
    const [picked] = copy.splice(index, 1);
    copy.splice(target, 0, picked);
    onChange(copy);
  };

  const addAction = (type: AutomationActionType) => {
    if (totalCount >= MAX_AUTOMATION_ACTIONS) return;
    onChange([...actions, createDefaultAction(type, fields, activeTableId)]);
    setPickerOpen(false);
  };

  const availableTypes = ACTION_ORDER.filter((type) => !(type === "if_condition" && depth >= MAX_IF_DEPTH));
  const atLimit = totalCount >= MAX_AUTOMATION_ACTIONS;

  return (
    <div className="space-y-2">
      {actions.length === 0 && (
        <p className="rounded-md border border-dashed py-3 text-center text-[12px] text-subtle">
          {t("尚未添加执行动作，点击下方按钮添加")}
        </p>
      )}
      {actions.map((act, idx) => {
        const meta = ACTION_META[act.type];
        const Icon = meta.icon;
        const notifySet = new Set(act.notifyUsers ?? []);
        return (
          <div
            key={act.id ?? idx}
            className="rounded-md border bg-sidebar/25 p-2.5"
            data-auto-action-item={idx}
            data-action-type={act.type}
          >
            <div className="mb-2 flex items-center gap-1.5">
              <span className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium", meta.badgeClass)}>
                <Icon size={12} />
                {t(meta.label)}
              </span>
              <div className="ml-auto flex items-center gap-0.5">
                <button
                  type="button"
                  aria-label={t("上移动作")}
                  disabled={idx === 0}
                  onClick={() => moveAt(idx, -1)}
                  className="grid size-6 place-items-center rounded text-subtle hover:bg-hover hover:text-foreground disabled:opacity-30"
                >
                  <ArrowUp size={13} />
                </button>
                <button
                  type="button"
                  aria-label={t("下移动作")}
                  disabled={idx === actions.length - 1}
                  onClick={() => moveAt(idx, 1)}
                  className="grid size-6 place-items-center rounded text-subtle hover:bg-hover hover:text-foreground disabled:opacity-30"
                >
                  <ArrowDown size={13} />
                </button>
                <button
                  type="button"
                  aria-label={t("删除动作")}
                  onClick={() => removeAt(idx)}
                  className="grid size-6 place-items-center rounded text-subtle hover:bg-hover hover:text-destructive"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>

            {act.type === "create_record" && (
              <div className="space-y-2">
                {tables.length > 1 && (
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 text-[12px] text-subtle">{t("目标数据表")}</span>
                    <FeishuSelect
                      ariaLabel={t("目标数据表")}
                      className="h-7 min-w-0 flex-1 border border-[#dee0e3] bg-surface px-1.5 text-[12px]"
                      chevronSize={11}
                      value={act.tableId ? String(act.tableId) : ""}
                      options={[
                        { value: "", label: t("当前数据表") },
                        ...tables.map((tbl) => ({ value: String(tbl.id), label: tbl.name })),
                      ]}
                      onChange={(val) => updateAt(idx, { tableId: val ? Number(val) : undefined })}
                    />
                  </div>
                )}
                <CellAssignmentsEditor
                  fields={fields}
                  allTriggerFields={fields}
                  cells={act.cells ?? {}}
                  onChange={(cells) => updateAt(idx, { cells })}
                  showFoundVar
                />
              </div>
            )}

            {act.type === "update_record" && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="shrink-0 text-[12px] text-subtle">{t("更新范围")}</span>
                  <FeishuSelect
                    ariaLabel={t("更新范围")}
                    className="h-7 min-w-0 flex-1 border border-[#dee0e3] bg-surface px-1.5 text-[12px]"
                    chevronSize={11}
                    value={act.targetScope === "found" ? "found" : "trigger"}
                    options={[
                      { value: "trigger", label: t("触发本次流程的记录") },
                      { value: "found", label: t("上一步查找到的记录") },
                    ]}
                    onChange={(val) => updateAt(idx, { targetScope: val === "found" ? "found" : "trigger" })}
                  />
                </div>
                <CellAssignmentsEditor
                  fields={fields}
                  allTriggerFields={fields}
                  cells={act.cells ?? {}}
                  onChange={(cells) => updateAt(idx, { cells })}
                  showFoundVar
                />
              </div>
            )}

            {act.type === "find_records" && (
              <div className="space-y-2">
                {tables.length > 1 && (
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 text-[12px] text-subtle">{t("查找数据表")}</span>
                    <FeishuSelect
                      ariaLabel={t("查找数据表")}
                      className="h-7 min-w-0 flex-1 border border-[#dee0e3] bg-surface px-1.5 text-[12px]"
                      chevronSize={11}
                      value={act.tableId ? String(act.tableId) : ""}
                      options={[
                        { value: "", label: t("当前数据表") },
                        ...tables.map((tbl) => ({ value: String(tbl.id), label: tbl.name })),
                      ]}
                      onChange={(val) => updateAt(idx, { tableId: val ? Number(val) : undefined })}
                    />
                  </div>
                )}
                <RuleListEditor
                  label={t("查找条件")}
                  fields={fields}
                  members={members}
                  rules={act.rules ?? []}
                  conj={act.conj === "or" ? "or" : "and"}
                  onChange={(rules, conj) => updateAt(idx, { rules, conj })}
                />
                <div className="flex items-center gap-2">
                  <span className="text-[12px] text-subtle">{t("最多查找条数")}</span>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={act.limit ?? 20}
                    onChange={(e) =>
                      updateAt(idx, { limit: Math.min(50, Math.max(1, Number(e.target.value) || 20)) })
                    }
                    className="h-7 w-20 rounded border bg-surface px-2 text-[12px] outline-none focus:border-primary"
                  />
                  <span className="text-[11px] text-subtle">{t("可用 {{found.count}}")}</span>
                </div>
              </div>
            )}

            {act.type === "if_condition" && (
              <div className="space-y-2.5">
                <RuleListEditor
                  label={t("判断条件（针对触发记录）")}
                  fields={fields}
                  members={members}
                  rules={act.rules ?? []}
                  conj={act.conj === "or" ? "or" : "and"}
                  onChange={(rules, conj) => updateAt(idx, { rules, conj })}
                />
                <div className="rounded-md border border-[#b7eb8f] bg-surface/90 p-2 dark:border-[#2a4e2f]" data-branch="then">
                  <p className="mb-1.5 text-[12px] font-medium text-[#237b19] dark:text-[#7bd88f]">{t("如果满足（执行）")}</p>
                  <ActionListEditor
                    actions={act.thenActions ?? []}
                    depth={depth + 1}
                    totalCount={totalCount}
                    fields={fields}
                    tables={tables}
                    activeTableId={activeTableId}
                    members={members}
                    onChange={(thenActions) => updateAt(idx, { thenActions })}
                  />
                </div>
                <div className="rounded-md border border-[#ffd591] bg-surface/90 p-2 dark:border-[#5b4118]" data-branch="else">
                  <p className="mb-1.5 text-[12px] font-medium text-[#b24d00] dark:text-[#ffc37a]">{t("否则（执行）")}</p>
                  <ActionListEditor
                    actions={act.elseActions ?? []}
                    depth={depth + 1}
                    totalCount={totalCount}
                    fields={fields}
                    tables={tables}
                    activeTableId={activeTableId}
                    members={members}
                    onChange={(elseActions) => updateAt(idx, { elseActions })}
                  />
                </div>
              </div>
            )}

            {act.type === "notify" && (
              <div className="space-y-1.5">
                <p className="text-[12px] text-subtle">{t("通知这些成员")}</p>
                <div className="max-h-24 space-y-0.5 overflow-y-auto rounded border bg-surface p-1">
                  {members.map((m) => (
                    <label key={m.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[12px] hover:bg-hover">
                      <input
                        type="checkbox"
                        className="accent-primary"
                        checked={notifySet.has(m.id)}
                        onChange={(e) => {
                          const next = new Set(notifySet);
                          if (e.target.checked) next.add(m.id);
                          else next.delete(m.id);
                          updateAt(idx, { notifyUsers: [...next] });
                        }}
                      />
                      {m.name}
                    </label>
                  ))}
                  {members.length === 0 && <p className="px-1 py-1 text-[11px] text-subtle">{t("暂无可通知成员")}</p>}
                </div>
                <input
                  value={act.message ?? ""}
                  onChange={(e) => updateAt(idx, { message: e.target.value })}
                  placeholder={t("通知消息，可用 {{field:字段ID}} 或 {{字段名}} 插值")}
                  className="h-8 w-full rounded border bg-surface px-2 text-[12px] outline-none focus:border-primary"
                  data-auto-message
                />
              </div>
            )}

            {act.type === "webhook" && (
              <div className="space-y-1.5">
                <FeishuSelect
                  ariaLabel={t("群机器人平台")}
                  className="h-8 w-full border border-[#dee0e3] bg-surface px-2 text-[12px]"
                  value={act.webhook?.kind ?? "feishu"}
                  options={[
                    { value: "feishu", label: t("飞书") },
                    { value: "wecom", label: t("企业微信") },
                    { value: "dingtalk", label: t("钉钉") },
                    { value: "generic", label: t("自建（通用 JSON）") },
                  ]}
                  onChange={(val) => updateAt(idx, { webhook: { ...act.webhook, kind: val } })}
                  dataAttr={{ "data-auto-hook-kind": true }}
                />
                <input
                  value={act.webhook?.url ?? ""}
                  onChange={(e) => updateAt(idx, { webhook: { ...act.webhook, url: e.target.value } })}
                  placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
                  className="h-8 w-full rounded border bg-surface px-2 font-mono text-[12px] outline-none focus:border-primary"
                  data-auto-hook-url
                />
                <input
                  value={act.webhook?.message ?? ""}
                  onChange={(e) => updateAt(idx, { webhook: { ...act.webhook, message: e.target.value } })}
                  placeholder={t("推送消息，可用 {{field:字段ID}}、{{base.title}}")}
                  className="h-8 w-full rounded border bg-surface px-2 text-[12px] outline-none focus:border-primary"
                />
              </div>
            )}
          </div>
        );
      })}

      {/* + 添加动作 选择器 */}
      <div className="relative">
        <button
          type="button"
          disabled={atLimit}
          onClick={() => setPickerOpen((v) => !v)}
          className="flex h-8 w-full items-center justify-center gap-1 rounded-md border border-dashed border-primary/50 text-[12px] font-medium text-primary hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
          data-add-action-btn
        >
          <Plus size={14} />
          {atLimit ? t("已达最大动作数（10）") : t("添加动作")}
        </button>
        {pickerOpen && !atLimit && (
          <div
            className="mt-1.5 grid grid-cols-2 gap-1.5 rounded-lg border bg-surface p-2 shadow-md"
            data-add-action-menu
          >
            {availableTypes.map((type) => {
              const meta = ACTION_META[type];
              const Icon = meta.icon;
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => addAction(type)}
                  data-add-action-type={type}
                  className="flex flex-col items-start rounded-md border px-2.5 py-2 text-left transition-colors hover:border-primary hover:bg-accent/50"
                >
                  <span className="flex items-center gap-1.5 text-[12px] font-medium text-foreground">
                    <Icon size={13} className="text-primary" />
                    {t(meta.label)}
                  </span>
                  <span className="mt-0.5 text-[11px] leading-tight text-subtle">{t(meta.desc)}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
