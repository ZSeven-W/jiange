import { cn } from "@/lib/utils";
import { initial } from "@/lib/presence";

const asset = (name: string) => `${import.meta.env.BASE_URL}brand/${name}`;

export function Logo({ className, withText = true, markClassName, wordmarkClassName, appearance = "auto" }: { className?: string; withText?: boolean; markClassName?: string; wordmarkClassName?: string; appearance?: "auto" | "light" }) {
  return (
    <span role="img" aria-label="Jiange" className={cn("inline-flex shrink-0 items-center gap-2.5", className)}>
      <img src={asset("jiange-mark.svg")} alt="" aria-hidden="true" className={cn("size-7 shrink-0", markClassName)} />
      {withText && <>
        <img src={asset("jiange-wordmark.svg")} alt="" aria-hidden="true" className={cn("h-[20px] w-auto", appearance === "auto" && "dark:hidden", wordmarkClassName)} />
        {appearance === "auto" && <img src={asset("jiange-wordmark-light.svg")} alt="" aria-hidden="true" className={cn("hidden h-[20px] w-auto dark:block", wordmarkClassName)} />}
      </>}
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
