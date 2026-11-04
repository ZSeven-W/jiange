import type { BaseRecord, Field } from "@/lib/api";
import { displayValue, REGISTRY } from "./registry";
import type { User } from "@/lib/api";

/** Client-side filter (any cell contains the keyword) and stable sort; empty cells sort last. */
export function view(records: BaseRecord[], fields: Field[], members: User[], sort: { f: number; desc: boolean } | null, filter: string): BaseRecord[] {
  const kw = filter.trim().toLowerCase();
  let out = kw
    ? records.filter((r) => fields.some((f) => REGISTRY[f.type].format(displayValue(r, f, members), f).toLowerCase().includes(kw)))
    : records;
  if (sort) {
    const f = fields.find((x) => x.id === sort.f);
    if (f) {
      const def = REGISTRY[f.type];
      out = [...out].sort((a, b) => {
        const x = displayValue(a, f, members);
        const y = displayValue(b, f, members);
        if (x === undefined || x === "" || (Array.isArray(x) && x.length === 0)) {
          if (y === undefined || y === "" || (Array.isArray(y) && y.length === 0)) return 0;
          return 1;
        }
        if (y === undefined || y === "" || (Array.isArray(y) && y.length === 0)) return -1;
        const c = def.compare(x, y, f);
        return sort.desc ? -c : c;
      });
    }
  }
  return out;
}
