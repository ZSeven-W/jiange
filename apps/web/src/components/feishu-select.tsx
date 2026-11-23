import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "../lib/utils";

export interface FeishuSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface FeishuSelectProps {
  id?: string;
  value: string;
  options: readonly FeishuSelectOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  title?: string;
  displayLabel?: string;
  disabled?: boolean;
  className?: string;
  chevronSize?: number;
  menuMinWidth?: number;
  dataAttr?: Record<string, string | boolean | undefined>;
}

/**
 * Feishu-style custom dropdown button + portaled listbox menu.
 * Replaces native `<select>` in toolbars so macOS/Chromium never paints
 * a dark native dropdown triangle alongside our hairline chevron.
 */
export function FeishuSelect({
  id,
  value,
  options,
  onChange,
  ariaLabel,
  title,
  displayLabel,
  disabled,
  className,
  chevronSize = 12,
  menuMinWidth,
  dataAttr,
}: FeishuSelectProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; minWidth: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selected = options.find((opt) => opt.value === value) ?? options[0];

  const computePos = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const width = Math.max(menuMinWidth ?? 0, rect.width, 84);
    const estHeight = Math.min(options.length * 32 + 10, 260);
    const fitsBelow = rect.bottom + 4 + estHeight <= window.innerHeight - 8;
    const top = fitsBelow ? rect.bottom + 4 : Math.max(8, rect.top - estHeight - 4);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    return { left, top, minWidth: width };
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onScrollOrResize = () => {
      const next = computePos();
      if (next) setPos(next);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("scroll", onScrollOrResize, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("scroll", onScrollOrResize, true);
    };
  }, [open, options.length, menuMinWidth]);

  const toggle = () => {
    if (disabled) return;
    if (open) {
      setOpen(false);
      return;
    }
    setPos(computePos());
    setOpen(true);
  };

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={title ?? ariaLabel}
        disabled={disabled}
        onClick={toggle}
        data-select-value={value}
        data-select-options={options.map((o) => `${o.value}:${o.label}`).join("|")}
        className={cn(
          "inline-flex h-8 shrink-0 cursor-pointer items-center justify-between gap-1.5 rounded-md bg-surface px-2 text-[13px] text-foreground transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-30",
          className,
        )}
        {...dataAttr}
      >
        <span className="truncate">{displayLabel ?? selected?.label ?? ""}</span>
        <ChevronDown size={chevronSize} className="shrink-0 text-[#8f959e]" aria-hidden />
      </button>
      {open && pos && typeof document !== "undefined" && createPortal(
        <div
          ref={menuRef}
          role="listbox"
          aria-label={ariaLabel}
          style={{ left: pos.left, top: pos.top, minWidth: pos.minWidth }}
          onPointerDown={(e) => e.stopPropagation()}
          className="fixed z-[120] max-h-[260px] overflow-y-auto rounded-lg border border-[#dee0e3] bg-surface py-1 text-[13px] shadow-[0_6px_20px_rgba(31,35,41,0.14)]"
        >
          {options.map((opt) => {
            const active = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={active}
                disabled={opt.disabled}
                onClick={() => {
                  if (opt.disabled) return;
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={cn(
                  "flex h-8 w-full items-center justify-between gap-2 px-2.5 text-left transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40",
                  active ? "font-medium text-[#3370ff]" : "text-foreground",
                )}
              >
                <span className="truncate">{opt.label}</span>
                {active && <Check size={13} className="shrink-0 text-[#3370ff]" aria-hidden />}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
