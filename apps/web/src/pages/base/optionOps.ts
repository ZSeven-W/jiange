import type { Field } from "@/lib/api";

/** Field patches for select-option edits made from the kanban column menu.
 * optionColors always stays parallel to options (-1 = automatic colour). */
export interface OptionPatch {
  options: string[];
  optionColors: number[];
  optionRenames?: Record<string, string>;
}

const colors = (f: Field) => (f.options ?? []).map((_, i) => f.optionColors?.[i] ?? -1);

export function renameOption(f: Field, from: string, to: string): OptionPatch | null {
  const name = to.trim();
  const options = f.options ?? [];
  if (!name || name === from || options.includes(name) || !options.includes(from)) return null;
  return { options: options.map((o) => (o === from ? name : o)), optionColors: colors(f), optionRenames: { [from]: name } };
}

export function recolorOption(f: Field, key: string, color: number): OptionPatch | null {
  const i = (f.options ?? []).indexOf(key);
  if (i < 0) return null;
  const c = colors(f);
  c[i] = color;
  return { options: [...(f.options ?? [])], optionColors: c };
}

export function deleteOption(f: Field, key: string): OptionPatch | null {
  const i = (f.options ?? []).indexOf(key);
  if (i < 0) return null;
  return { options: (f.options ?? []).filter((_, j) => j !== i), optionColors: colors(f).filter((_, j) => j !== i) };
}

/** Move option `key` so it lands before the option currently at `to` (to = length → end). */
export function moveOption(f: Field, key: string, to: number): OptionPatch | null {
  const options = f.options ?? [];
  const from = options.indexOf(key);
  if (from < 0) return null;
  const c = colors(f);
  const target = to > from ? to - 1 : to;
  if (target === from) return null;
  const o = [...options];
  const [name] = o.splice(from, 1);
  const [col] = c.splice(from, 1);
  o.splice(target, 0, name);
  c.splice(target, 0, col);
  return { options: o, optionColors: c };
}
