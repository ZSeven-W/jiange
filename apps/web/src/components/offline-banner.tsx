import { Download, Wifi, WifiOff, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import {
  useNetworkStatus,
  usePwaInstallPrompt,
  type NetworkStatus,
  type PwaInstallPromptState,
} from "@/lib/pwa";
import { cn } from "@/lib/utils";

export interface OfflineBannerProps {
  /** Optional network status override (defaults to live `useNetworkStatus()`). */
  status?: NetworkStatus;
  /** Floating pill placement along the viewport edge (defaults to `"bottom"`). */
  position?: "top" | "bottom";
  /** Optional additional class names for the fixed positioning container. */
  className?: string;
}

/**
 * Non-blocking Feishu-styled network connectivity status pill.
 * Renders an amber offline indicator while disconnected, a brief green sync confirmation
 * for 3.5s after reconnecting, and `null` during normal online usage.
 */
export function OfflineBanner({
  status,
  position = "bottom",
  className,
}: OfflineBannerProps) {
  const { t } = useI18n();
  const liveStatus = useNetworkStatus();
  const { online, justReconnected } = status ?? liveStatus;

  if (online && !justReconnected) {
    return null;
  }

  const containerClass = cn(
    "pointer-events-none fixed inset-x-0 z-[65] flex justify-center px-4 print:hidden",
    position === "top" ? "top-3" : "bottom-4 safe-area-bottom",
    className,
  );

  if (!online) {
    return (
      <div className={containerClass}>
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-offline-banner=""
          className="pointer-events-auto inline-flex max-w-[min(560px,calc(100vw-32px))] items-center gap-2 rounded-full border border-[#ffd591] bg-[#fff7e6]/95 px-3.5 py-2 text-[13px] font-medium leading-snug text-[#8c4a00] shadow-[0_6px_20px_rgba(31,35,41,0.12)] backdrop-blur-md dark:border-[#6e4b1f] dark:bg-[#2b2215]/95 dark:text-[#ffd591] dark:shadow-[0_6px_20px_rgba(0,0,0,0.4)]"
        >
          <WifiOff
            size={15}
            strokeWidth={2}
            className="shrink-0 text-[#ff8800] dark:text-[#ffb74d]"
            aria-hidden="true"
          />
          <span>{t("网络已断开，本地草稿已暂存，恢复联网后将自动同步")}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={containerClass}>
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-reconnected-banner=""
        className="pointer-events-auto inline-flex max-w-[min(480px,calc(100vw-32px))] items-center gap-2 rounded-full border border-[#b7eb8f] bg-[#f6ffed]/95 px-3.5 py-2 text-[13px] font-medium leading-snug text-[#135200] shadow-[0_6px_20px_rgba(31,35,41,0.12)] backdrop-blur-md dark:border-[#235d2d] dark:bg-[#132617]/95 dark:text-[#95de64] dark:shadow-[0_6px_20px_rgba(0,0,0,0.4)]"
      >
        <Wifi
          size={15}
          strokeWidth={2}
          className="shrink-0 text-[#00b42a] dark:text-[#47d16c]"
          aria-hidden="true"
        />
        <span>{t("网络已恢复，正在同步最新内容")}</span>
      </div>
    </div>
  );
}

export interface PwaInstallButtonProps {
  /** Optional install prompt override (defaults to live `usePwaInstallPrompt()`). */
  installPrompt?: Pick<PwaInstallPromptState, "canInstall" | "promptInstall" | "dismiss">;
  /** Compact variant for narrow sidebars or headers. */
  compact?: boolean;
  /** Whether to show a subtle dismiss icon alongside the install trigger (defaults to `true`). */
  dismissible?: boolean;
  className?: string;
}

/**
 * Compact Feishu-blue PWA install pill shown only when the browser reports
 * the app is installable (`beforeinstallprompt`).
 */
export function PwaInstallButton({
  installPrompt,
  compact = false,
  dismissible = true,
  className,
}: PwaInstallButtonProps) {
  const { t } = useI18n();
  const livePrompt = usePwaInstallPrompt();
  const { canInstall, promptInstall, dismiss } = installPrompt ?? livePrompt;

  if (!canInstall) {
    return null;
  }

  return (
    <div
      data-pwa-install-button=""
      className={cn(
        "inline-flex items-center overflow-hidden rounded-full border border-[#3370ff]/25 bg-[#e8f0ff] text-[#1456f0] shadow-xs transition-colors dark:border-[#3370ff]/40 dark:bg-[#1d3461] dark:text-[#9cbdff]",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => void promptInstall()}
        title={t("将 Jiange 安装到设备")}
        aria-label={t("将 Jiange 安装到设备")}
        data-pwa-install-trigger=""
        className={cn(
          "inline-flex items-center gap-1.5 font-medium transition-colors hover:bg-[#3370ff]/12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3370ff] dark:hover:bg-[#3370ff]/25",
          compact ? "px-2.5 py-1 text-[12px]" : "px-3 py-1.5 text-[12.5px]",
        )}
      >
        <Download size={compact ? 12 : 13} strokeWidth={2} className="shrink-0" aria-hidden="true" />
        <span>{t("安装应用")}</span>
      </button>
      {dismissible && (
        <button
          type="button"
          onClick={dismiss}
          title={t("关闭安装提示")}
          aria-label={t("关闭安装提示")}
          data-pwa-install-dismiss=""
          className={cn(
            "grid place-items-center border-l border-[#3370ff]/20 text-[#3370ff]/75 transition-colors hover:bg-[#3370ff]/12 hover:text-[#1456f0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3370ff] dark:border-[#3370ff]/35 dark:text-[#9cbdff]/80 dark:hover:bg-[#3370ff]/25 dark:hover:text-white",
            compact ? "size-6" : "size-7",
          )}
        >
          <X size={12} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
