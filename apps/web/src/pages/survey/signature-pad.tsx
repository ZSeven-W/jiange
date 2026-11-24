import { useRef, useState } from "react";
import { Eraser } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export function SignaturePad({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (dataUrl: string) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [hasStroke, setHasStroke] = useState(Boolean(value));

  const getPoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    canvas.setPointerCapture(e.pointerId);
    drawing.current = true;
    const pt = getPoint(e);
    ctx.strokeStyle = "#1F2329";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(pt.x, pt.y);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || disabled) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const pt = getPoint(e);
    ctx.lineTo(pt.x, pt.y);
    ctx.stroke();
    setHasStroke(true);
  };

  const handlePointerUp = () => {
    if (!drawing.current) return;
    drawing.current = false;
    const canvas = canvasRef.current;
    if (canvas && hasStroke) {
      onChange(canvas.toDataURL("image/png"));
    }
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasStroke(false);
    onChange("");
  };

  return (
    <div className="space-y-2" data-signature-pad>
      <div className="relative overflow-hidden rounded-lg border border-dashed border-[#C9CDD4] bg-white dark:border-border">
        <canvas
          ref={canvasRef}
          width={520}
          height={150}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
          className="block h-[140px] w-full touch-none cursor-crosshair"
        />
        {!hasStroke && !value && (
          <span className="pointer-events-none absolute inset-0 grid place-items-center text-[13px] text-muted-foreground">
            {t("请在此区域手写签名")}
          </span>
        )}
      </div>
      <div className="flex items-center justify-between text-[12px] text-muted-foreground">
        <span>{value ? t("已采集电子签名") : t("支持鼠标或触控笔手写签名")}</span>
        {!disabled && (
          <button
            type="button"
            onClick={clear}
            data-signature-clear
            className="inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-hover hover:text-foreground"
          >
            <Eraser size={12} />{t("清除重写")}
          </button>
        )}
      </div>
    </div>
  );
}
