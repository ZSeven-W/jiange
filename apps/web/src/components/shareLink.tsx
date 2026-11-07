import { QRCodeSVG } from "qrcode.react";
import type { ShareInfo } from "@/lib/api";

/** Only expose a link after the current permission read has succeeded. */
export function verifiedShareUrl(info: ShareInfo | undefined, origin: string, verified: boolean): string {
  if (!verified || !info || info.link.role === "none" || !info.link.token) return "";
  return `${origin}/#/${info.link.role === "anon" ? "p" : "s"}/${encodeURIComponent(info.link.token)}`;
}

/** Generated in the browser; the URL is never sent to a QR service. */
export function ShareQRCode({ url }: { url: string }) {
  if (!url || new TextEncoder().encode(url).length > 1000) return <p role="alert" className="text-[12px] text-destructive">链接过长，无法生成二维码，请复制链接分享。</p>;
  return <QRCodeSVG value={url} size={160} level="M" marginSize={4} role="img" aria-label="扫描二维码打开分享链接" />;
}
