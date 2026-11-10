import type { FilterRule, User } from "@/lib/api";
import { cn } from "@/lib/utils";
import { personRuleIDs } from "./registry";
import { Check } from "lucide-react";

/**
 * 人员字段的筛选值输入：包含/不包含为成员多选 chips（v = number[]），
 * 等于/不等于为成员单选（v = number）。Automations 与视图筛选共用。
 */
export function MemberRuleValue({ rule, members, onChange }: { rule: FilterRule; members: User[]; onChange: (v: FilterRule["v"]) => void }) {
  const multi = rule.op === "contains" || rule.op === "not_contains";
  if (!multi) {
    const current = personRuleIDs(rule.v)[0] ?? 0;
    return (
      <select
        className="h-7 min-w-0 flex-1 rounded border bg-surface px-1"
        value={current || ""}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : 0)}
        data-person-filter
        aria-label="选择成员"
      >
        <option value="">—</option>
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
    );
  }
  const picked = personRuleIDs(rule.v);
  const toggle = (id: number) => {
    const next = picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id];
    onChange(next.length ? next : []);
  };
  return (
    <div className="flex min-h-7 min-w-0 flex-1 flex-wrap items-center gap-1 rounded border px-1 py-0.5" data-person-filter-multi>
      {members.map((m) => {
        const on = picked.includes(m.id);
        return (
          <button
            key={m.id}
            type="button"
            aria-pressed={on}
            onClick={() => toggle(m.id)}
            className={cn("flex h-5 items-center gap-1 rounded px-1.5 text-[12px]", on ? "bg-accent font-medium text-primary" : "bg-hover text-muted-foreground hover:text-foreground")}
          >
            {on && <Check size={11} />} {m.name}
          </button>
        );
      })}
      {members.length === 0 && <span className="px-1 text-[12px] text-subtle">没有可选成员</span>}
    </div>
  );
}

/** Person 字段筛选的合法默认/规范化值：contains → id 数组，is → 单个 id。 */
export function personRuleValue(op: string, v: FilterRule["v"]): FilterRule["v"] {
  if (op === "contains" || op === "not_contains") return personRuleIDs(v);
  const first = personRuleIDs(v)[0];
  return first ?? 0;
}
