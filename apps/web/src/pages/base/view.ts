import type { BaseRecord, Cell, Field } from "@/lib/api";

/** Client-side filter (any cell contains the keyword) and stable sort; empty cells sort last. */
export function view(records: BaseRecord[], fields: Field[], sort: { f: number; desc: boolean } | null, filter: string): BaseRecord[] {
  const kw = filter.trim().toLowerCase();
  let out = kw ? records.filter((r) => fields.some((f) => r.cells[f.id] !== undefined && String(r.cells[f.id]).toLowerCase().includes(kw))) : records;
  if (sort) {
    const f = fields.find((x) => x.id === sort.f);
    if (f) {
      const rank = (v: Cell | undefined) => (f.type === "select" ? (f.options ?? []).indexOf(String(v)) : v);
      out = [...out].sort((a, b) => {
        const x = a.cells[f.id], y = b.cells[f.id];
        if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? 1 : -1;
        const rx = rank(x)!, ry = rank(y)!;
        const c = typeof rx === "number" && typeof ry === "number" ? rx - ry : String(rx).localeCompare(String(ry), "zh-CN");
        return sort.desc ? -c : c;
      });
    }
  }
  return out;
}
