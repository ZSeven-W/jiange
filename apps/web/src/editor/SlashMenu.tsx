import { Command, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import type { MenuItem } from "./pinyin";

export function SlashMenu({ x, y, items, index, onPick, onHover }: { x: number; y: number; items: MenuItem[]; index: number; onPick: (it: MenuItem) => void; onHover: (i: number) => void }) {
  const groups = [...new Set(items.map((i) => i.group))];
  return (
    <div className="absolute z-30 w-[264px]" style={{ left: x, top: y }} onMouseDown={(e) => e.preventDefault()} data-slash-menu>
      <Command shouldFilter={false} value={items[index]?.id ?? ""} className="rounded-lg border bg-white p-1.5 shadow-[0_6px_24px_rgba(31,35,41,0.12)]">
        <CommandList className="max-h-[320px]">
          {items.length === 0 && <div className="px-3 py-2 text-[13px] text-subtle">没有匹配的块</div>}
          {groups.map((g) => (
            <CommandGroup key={g} heading={g}>
              {items
                .filter((i) => i.group === g)
                .map((it) => (
                  <CommandItem key={it.id} value={it.id} onSelect={() => onPick(it)} onMouseEnter={() => onHover(items.indexOf(it))}>
                    <span className="grid size-6 place-items-center rounded border text-[11px] font-semibold text-muted-foreground">{it.icon}</span>
                    <span className="flex-1">{it.label}</span>
                    <span className="text-[11px] text-subtle">{it.py.map((p) => p[0]).join("")}</span>
                  </CommandItem>
                ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </div>
  );
}
