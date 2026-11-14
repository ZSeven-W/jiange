import type { ReactNode } from "react";
import { FileQuestion } from "lucide-react";
import { isKnownNodeKind, nodeHref } from "@/lib/route";
import { useI18n } from "@/lib/i18n";

/** An unknown kind is never opened in an editor or interpreted as a document. */
export function ResourceTypeNotice({ id, kind, verified = false, blockNavigation = false, children }: { id: number; kind?: string; verified?: boolean; blockNavigation?: boolean; children?: ReactNode }) {
  const { t } = useI18n();
  const target = verified && isKnownNodeKind(kind) ? nodeHref({ id, kind }) : null;
  return <div className="grid min-h-0 flex-1 place-items-center px-5 py-10" role="alert" data-resource-type-notice>
    <div className="flex max-w-md flex-col items-center text-center">
      <span className="grid size-14 place-items-center rounded-2xl bg-[#f2f4f7] text-[#8f959e]"><FileQuestion size={28} strokeWidth={1.5}/></span>
      <h1 className="mt-4 text-[16px] font-medium text-foreground">{t("无法在此打开该文件")}</h1>
      <p className="mt-2 text-[13px] leading-6 text-muted-foreground">{target ? t("此链接指向其他类型的文件，请使用对应入口打开。") : t("当前版本暂不支持此文件类型，或无法确认文件类型。")}</p>
      {children}
      {!blockNavigation && <div className="mt-5 flex flex-wrap justify-center gap-2">{target && <a href={target} className="rounded-md bg-primary px-4 py-2 text-[13px] text-white hover:bg-primary-hover">{t("打开对应文件")}</a>}<a href="#/" className="rounded-md border px-4 py-2 text-[13px] text-foreground hover:bg-hover">{t("返回主页")}</a></div>}
    </div>
  </div>;
}
