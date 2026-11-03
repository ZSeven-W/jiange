import { cn } from "@/lib/utils";
import { initial } from "@/lib/presence";

export function Logo({ className, withText = true }: { className?: string; withText?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <span className="grid size-7 place-items-center rounded-[7px] bg-primary text-[15px] font-bold text-white">J</span>
      {withText && <span className="text-[18px] font-semibold tracking-tight text-foreground">Jiange</span>}
    </span>
  );
}

export function Avatar({ name, color, size = 24, ring = false, title }: { name: string; color: string; size?: number; ring?: boolean; title?: string }) {
  return (
    <span
      title={title ?? name}
      className={cn("grid shrink-0 place-items-center rounded-full font-semibold text-white", ring && "ring-2 ring-white")}
      style={{ width: size, height: size, background: color, fontSize: Math.round(size * 0.46) }}
    >
      {initial(name)}
    </span>
  );
}
