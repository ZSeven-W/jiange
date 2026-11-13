import { t } from "@/lib/i18n";
import { QRCodeSVG } from "qrcode.react";
import type { DocMeta, ShareInfo } from "@/lib/api";
import { nodeHref } from "@/lib/route";

/** Only expose a link after the current permission read has succeeded. */
export function verifiedShareUrl(info: ShareInfo | undefined, origin: string, verified: boolean): string {
  if (!verified || !info || info.link.role === "none" || !info.link.token) return "";
  return `${origin}/#/${info.link.role === "anon" ? "p" : "s"}/${encodeURIComponent(info.link.token)}`;
}

/** A direct address identifies the document but does not grant access. Never
 * reuse an old sharing token when link sharing is disabled. */
export function verifiedDirectShareUrl(info: ShareInfo | undefined, meta: Pick<DocMeta, "id" | "kind">, origin: string, pathname: string, verified: boolean): string {
  if (!verified || !info || !["view", "edit", "manage"].includes(info.role) || info.link?.role !== "none" || !Number.isSafeInteger(meta.id) || meta.id <= 0 || ![undefined, "doc", "base", "slides", "file"].includes(meta.kind) || typeof pathname !== "string" || !pathname.startsWith("/") || pathname.startsWith("//")) return "";
  try {
    const base = new URL(origin);
    const url = new URL(pathname, base);
    if (!/^https?:$/.test(base.protocol) || url.origin !== base.origin) return "";
    url.hash = nodeHref(meta);
    return url.toString();
  } catch { return ""; }
}

/** Generated in the browser; the URL is never sent to a QR service. */
export function ShareQRCode({ url }: { url: string }) {
  if (!url || new TextEncoder().encode(url).length > 1000) return <p role="alert" className="text-[12px] text-destructive">{t("链接过长，无法生成二维码，请复制链接分享。")}</p>;
  return <QRCodeSVG value={url} size={160} level="M" marginSize={4} role="img" aria-label={t("扫描二维码打开分享链接")} />;
}
