import type { FormFieldDef, FormValue } from "./PublicForm";

export type FormDraftEntry = { id: number; name: string; type: string; value: FormValue };
export type FormDraftRead = { values: Record<number, FormValue>; unmatched: FormDraftEntry[]; unreadable: string | null };
const MAX_DRAFT_LENGTH = 1_000_000;
const draftKey = (pendingKey: string) => `${pendingKey}:draft:v1`;

function validEntry(value: unknown): value is FormDraftEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).sort().join(",") !== "id,name,type,value" || !Number.isSafeInteger(entry.id) || (entry.id as number) <= 0 || typeof entry.name !== "string" || entry.name.length > 2000 || typeof entry.type !== "string" || entry.type.length > 100) return false;
  if (typeof entry.value === "string") return entry.value.length <= 20000 && !entry.value.includes("\0");
  if (typeof entry.value === "boolean") return true;
  return Array.isArray(entry.value) && entry.value.length <= 1000 && entry.value.every((item) => typeof item === "string" && item.length <= 2000 && !item.includes("\0"));
}

function compatible(field: FormFieldDef, value: FormValue): boolean {
  if (field.type === "checkbox") return typeof value === "boolean";
  if (field.type === "multi_select") return Array.isArray(value) && new Set(value).size === value.length && value.every((item) => (field.options ?? []).includes(item));
  if (typeof value !== "string") return false;
  if (field.type === "select") return value === "" || (field.options ?? []).includes(value);
  if (field.type === "rating") return value === "" || ["1", "2", "3", "4", "5"].includes(value);
  return ["text", "number", "date", "url", "phone", "email"].includes(field.type);
}

/** Never use a raw public token as a storage key; the caller supplies its digest. */
export function readPublicFormDraft(storage: Pick<Storage, "getItem">, pendingKey: string, fields: readonly FormFieldDef[]): FormDraftRead {
  const empty: FormDraftRead = { values: {}, unmatched: [], unreadable: null };
  try {
    const raw = storage.getItem(draftKey(pendingKey));
    if (!raw) return empty;
    if (raw.length > MAX_DRAFT_LENGTH) return { ...empty, unreadable: "草稿过大，无法自动恢复。" };
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return { ...empty, unreadable: raw }; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...empty, unreadable: raw };
    const data = parsed as Record<string, unknown>;
    if (data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > 1000 || !data.entries.every(validEntry)) return { ...empty, unreadable: raw };
    const byId = new Map(fields.map((field) => [field.id, field])), values: Record<number, FormValue> = {}, unmatched: FormDraftEntry[] = [];
    for (const entry of data.entries as FormDraftEntry[]) {
      const field = byId.get(entry.id);
      if (field && field.name === entry.name && field.type === entry.type && compatible(field, entry.value) && !Object.hasOwn(values, entry.id)) values[entry.id] = entry.value;
      else unmatched.push(entry);
    }
    return { values, unmatched, unreadable: null };
  } catch { return { ...empty, unreadable: "浏览器存储不可用，无法自动恢复草稿。" }; }
}

export function writePublicFormDraft(storage: Pick<Storage, "setItem" | "removeItem">, pendingKey: string, fields: readonly FormFieldDef[], values: Record<number, FormValue>, unmatched: readonly FormDraftEntry[]): boolean {
  try {
    if (!unmatched.every(validEntry)) return false;
    const entries: FormDraftEntry[] = [...unmatched];
    for (const field of fields) {
      const value = values[field.id];
      if (value === undefined || value === "" || Array.isArray(value) && !value.length) continue;
      const entry = { id: field.id, name: field.name, type: field.type, value };
      if (!validEntry(entry)) return false;
      entries.push(entry);
    }
    if (!entries.length) { storage.removeItem(draftKey(pendingKey)); return true; }
    if (entries.length > 1000) return false;
    const raw = JSON.stringify({ version: 1, entries });
    if (raw.length > MAX_DRAFT_LENGTH) return false;
    storage.setItem(draftKey(pendingKey), raw); return true;
  } catch { return false; }
}
export function clearPublicFormDraft(storage: Pick<Storage, "removeItem">, pendingKey: string): boolean {
  try { storage.removeItem(draftKey(pendingKey)); return true; } catch { return false; }
}
