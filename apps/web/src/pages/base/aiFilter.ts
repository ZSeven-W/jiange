import type { Field, FilterRule, User } from "@/lib/api";
import type { AIMessage } from "@/lib/ai";

/** Operators the filter panel supports per field type (kept in sync with BasePage). */
export function filterOpsFor(type: string): string[] {
  switch (type) {
    case "number": return ["is", "is_not", "gt", "gte", "lt", "lte", "empty", "not_empty"];
    case "checkbox": return ["checked", "unchecked"];
    case "date": return ["is", "gt", "lt", "empty", "not_empty"];
    default: return ["contains", "not_contains", "is", "is_not", "empty", "not_empty"];
  }
}

const NO_VALUE = new Set(["empty", "not_empty", "checked", "unchecked"]);

/** 把字段结构与当前日期交给模型，要求只返回 JSON 筛选条件。 */
export function aiFilterPrompt(request: string, fields: Field[], members: User[], today: string): AIMessage[] {
  const schema = fields.filter((f) => f.type !== "attachment").map((f) => ({
    id: f.id, name: f.name, type: f.type, ops: filterOpsFor(f.type),
    ...(f.options?.length ? { options: f.options.slice(0, 50) } : {}),
    ...(f.type === "person" || f.type === "created_by" ? { members: members.slice(0, 50).map((m) => ({ id: m.id, name: m.name })) } : {}),
  }));
  return [
    { role: "system", content: `你把用户对多维表格的筛选描述转换为 JSON。只输出 JSON，不要解释。格式：{"conj":"and"|"or","rules":[{"f":字段id,"op":运算符,"v":值}]}。只能使用下面给出的字段 id 和该字段的 ops；empty/not_empty/checked/unchecked 不需要 v；日期用 YYYY-MM-DD；选项值必须是给出的 options 之一；人员字段 contains/not_contains 的 v 是成员 id 数组，is/is_not 的 v 是单个成员 id。今天是 ${today}。无法表达时返回 {"conj":"and","rules":[]}。\n字段：${JSON.stringify(schema)}` },
    { role: "user", content: request.slice(0, 500) },
  ];
}

/** Validate the model's answer strictly; anything outside the schema is dropped. */
export function parseAiFilter(answer: string, fields: Field[]): { conj: "and" | "or"; rules: FilterRule[]; dropped: number } | null {
  const start = answer.indexOf("{"), end = answer.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try { raw = JSON.parse(answer.slice(start, end + 1)); } catch { return null; }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { rules?: unknown }).rules)) return null;
  const conj = (raw as { conj?: unknown }).conj === "or" ? "or" : "and";
  const rules: FilterRule[] = [];
  let dropped = 0;
  for (const item of (raw as { rules: unknown[] }).rules.slice(0, 20)) {
    const r = item as { f?: unknown; op?: unknown; v?: unknown };
    const field = fields.find((f) => f.id === Number(r.f));
    if (!field || typeof r.op !== "string" || !filterOpsFor(field.type).includes(r.op)) { dropped++; continue; }
    if (NO_VALUE.has(r.op)) { rules.push({ f: field.id, op: r.op }); continue; }
    let v = r.v;
    if (field.type === "person") {
      const ids = (Array.isArray(v) ? v : [v]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      if (!ids.length) { dropped++; continue; }
      v = r.op === "contains" || r.op === "not_contains" ? ids : ids[0];
    } else if (field.type === "number") {
      if (typeof v !== "number" && !(typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)))) { dropped++; continue; }
      v = Number(v);
    } else if (field.type === "date") {
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) { dropped++; continue; }
    } else if ((field.type === "select" || field.type === "multi_select") && field.options?.length) {
      if (typeof v !== "string" || !field.options.includes(v)) { dropped++; continue; }
    } else if (typeof v !== "string" && typeof v !== "number") { dropped++; continue; }
    rules.push({ f: field.id, op: r.op, v: typeof v === "number" && field.type !== "number" && field.type !== "person" ? String(v) : (v as FilterRule["v"]) });
  }
  return { conj, rules, dropped };
}
