export type FormBranchOperator = "eq" | "neq" | "not_empty" | "checked";

export interface FormBranchRule {
  id: string;
  targetFieldId: number;
  sourceFieldId: number;
  operator: FormBranchOperator;
  value?: string;
}

export const FORM_BRANCH_OPERATORS: readonly { value: FormBranchOperator; label: string }[] = [
  { value: "eq", label: "等于" },
  { value: "neq", label: "不等于" },
  { value: "not_empty", label: "非空" },
  { value: "checked", label: "已勾选" },
];

const VALID_OPS = new Set<string>(FORM_BRANCH_OPERATORS.map((o) => o.value));
const STORAGE_PREFIX = "jiange:base:form-branching:";

export function formBranchingStorageKey(baseId: number, viewId: number): string {
  return `${STORAGE_PREFIX}${baseId}:${viewId}`;
}

export function isValidFormBranchRule(value: unknown): value is FormBranchRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id.trim()) return false;
  if (typeof r.targetFieldId !== "number" || !Number.isSafeInteger(r.targetFieldId) || r.targetFieldId <= 0) return false;
  if (typeof r.sourceFieldId !== "number" || !Number.isSafeInteger(r.sourceFieldId) || r.sourceFieldId <= 0) return false;
  if (r.targetFieldId === r.sourceFieldId) return false;
  if (typeof r.operator !== "string" || !VALID_OPS.has(r.operator)) return false;
  if (r.value !== undefined && typeof r.value !== "string") return false;
  return true;
}

/** Load persisted branching rules for a specific form view. */
export function loadFormBranchRules(baseId: number, viewId: number): FormBranchRule[] {
  if (!Number.isSafeInteger(baseId) || baseId <= 0 || !Number.isSafeInteger(viewId) || viewId <= 0) return [];
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(formBranchingStorageKey(baseId, viewId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidFormBranchRule);
  } catch {
    return [];
  }
}

/** Persist branching rules for a specific form view. */
export function saveFormBranchRules(baseId: number, viewId: number, rules: readonly FormBranchRule[]): void {
  if (!Number.isSafeInteger(baseId) || baseId <= 0 || !Number.isSafeInteger(viewId) || viewId <= 0) return;
  if (typeof localStorage === "undefined") return;
  try {
    const valid = rules.filter(isValidFormBranchRule);
    if (valid.length === 0) {
      localStorage.removeItem(formBranchingStorageKey(baseId, viewId));
    } else {
      localStorage.setItem(formBranchingStorageKey(baseId, viewId), JSON.stringify(valid));
    }
  } catch {
    // Ignore storage quota / privacy mode failures.
  }
}

/**
 * Look up persisted branching rules matching a public form's field IDs when the
 * server definition doesn't inline `branchRules` yet. Never touches bearer tokens.
 */
export function loadBranchRulesForFields(fieldIds: readonly number[]): FormBranchRule[] {
  if (fieldIds.length === 0 || typeof localStorage === "undefined") return [];
  const allowed = new Set(fieldIds);
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(STORAGE_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) continue;
      const matching = parsed.filter(
        (item): item is FormBranchRule =>
          isValidFormBranchRule(item) && allowed.has(item.sourceFieldId) && allowed.has(item.targetFieldId),
      );
      if (matching.length > 0) return matching;
    }
  } catch {
    return [];
  }
  return [];
}

function isNonEmptyValue(rawValue: unknown): boolean {
  if (rawValue === undefined || rawValue === null) return false;
  if (typeof rawValue === "string") return rawValue.trim().length > 0;
  if (Array.isArray(rawValue)) return rawValue.length > 0;
  if (typeof rawValue === "boolean") return rawValue === true;
  if (typeof rawValue === "number") return Number.isFinite(rawValue);
  return false;
}

function equalsValue(rawValue: unknown, expectedRaw: string | undefined): boolean {
  const expected = (expectedRaw ?? "").trim();
  if (Array.isArray(rawValue)) {
    return rawValue.some((item) => String(item).trim() === expected);
  }
  if (rawValue === undefined || rawValue === null) {
    return expected === "";
  }
  if (typeof rawValue === "boolean") {
    return String(rawValue) === expected.toLowerCase();
  }
  return String(rawValue).trim() === expected;
}

/** Evaluate a single conditional branching rule against a field value. */
export function matchesFormBranchRule(rule: FormBranchRule, rawValue: unknown): boolean {
  switch (rule.operator) {
    case "not_empty":
      return isNonEmptyValue(rawValue);
    case "checked":
      return rawValue === true || rawValue === "true";
    case "eq":
      return equalsValue(rawValue, rule.value);
    case "neq":
      return !equalsValue(rawValue, rule.value);
  }
}

/** Check whether adding `sourceFieldId -> targetFieldId` would introduce a visibility cycle. */
export function wouldCreateBranchCycle(
  rules: readonly Pick<FormBranchRule, "sourceFieldId" | "targetFieldId">[],
  sourceFieldId: number,
  targetFieldId: number,
): boolean {
  if (sourceFieldId === targetFieldId) return true;
  const adj = new Map<number, number[]>();
  for (const r of rules) {
    const list = adj.get(r.sourceFieldId);
    if (list) list.push(r.targetFieldId);
    else adj.set(r.sourceFieldId, [r.targetFieldId]);
  }
  const visited = new Set<number>([targetFieldId]);
  const stack = [targetFieldId];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const next of adj.get(cur) ?? []) {
      if (next === sourceFieldId) return true;
      if (!visited.has(next)) {
        visited.add(next);
        stack.push(next);
      }
    }
  }
  return false;
}

/**
 * Return only the fields whose conditional visibility rules are satisfied.
 * Supports arbitrary chaining (A -> B -> C): if an upstream source field is itself
 * hidden, downstream dependent fields are also hidden even if stale values exist.
 * Cycles are broken safely (fields in a cycle stay hidden).
 */
export function visibleFormFields<T extends { id: number }>(
  fields: readonly T[],
  rules: readonly FormBranchRule[],
  values: Record<number, unknown>,
): T[] {
  if (rules.length === 0) return [...fields];
  const fieldIds = new Set(fields.map((f) => f.id));
  const rulesByTarget = new Map<number, FormBranchRule[]>();
  for (const rule of rules) {
    if (
      rule.sourceFieldId === rule.targetFieldId ||
      !fieldIds.has(rule.sourceFieldId) ||
      !fieldIds.has(rule.targetFieldId)
    ) {
      continue;
    }
    const list = rulesByTarget.get(rule.targetFieldId);
    if (list) list.push(rule);
    else rulesByTarget.set(rule.targetFieldId, [rule]);
  }
  if (rulesByTarget.size === 0) return [...fields];

  const memo = new Map<number, boolean>();
  const visiting = new Set<number>();

  const isVisible = (fieldId: number): boolean => {
    const cached = memo.get(fieldId);
    if (cached !== undefined) return cached;
    if (visiting.has(fieldId)) return false;
    visiting.add(fieldId);
    const incoming = rulesByTarget.get(fieldId);
    let ok = true;
    if (incoming && incoming.length > 0) {
      ok = incoming.every((rule) => isVisible(rule.sourceFieldId) && matchesFormBranchRule(rule, values[rule.sourceFieldId]));
    }
    visiting.delete(fieldId);
    memo.set(fieldId, ok);
    return ok;
  };

  return fields.filter((field) => isVisible(field.id));
}
