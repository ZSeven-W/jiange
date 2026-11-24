import { useEffect, useState } from "react";
import { Database, Download, RefreshCw, Wifi, WifiOff, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useOfflineState, type OfflineStateHookValue } from "@/lib/offline-sync";
import {
  useNetworkStatus,
  usePwaInstallPrompt,
  type NetworkStatus,
  type PwaInstallPromptState,
} from "@/lib/pwa";
import { cn } from "@/lib/utils";
import {
  OFFLINE_CACHE_DRAWER_EVENT,
  OfflineCacheDrawer,
  openOfflineCacheDrawer,
  type OfflineCacheTab,
} from "./offline-cache-viewer";

export { openOfflineCacheDrawer } from "./offline-cache-viewer";

export interface OfflineBannerProps {
  /** Optional network status override (defaults to live `useNetworkStatus()`). */
  status?: NetworkStatus;
  /** Optional offline state override (defaults to live `useOfflineState()`). */
  offlineState?: OfflineStateHookValue;
  /** Optional initial drawer visibility (primarily for tests). */
  initialDrawerOpen?: boolean;
  /** Optional initial drawer tab when opened (defaults to `"snapshots"`). */
  initialDrawerTab?: OfflineCacheTab;
  /** Floating pill placement along the viewport edge (defaults to `"bottom"`). */
  position?: "top" | "bottom";
  /** Optional additional class names for the fixed positioning container. */
  className?: string;
}

/**
 * Non-blocking Feishu-styled network & offline sync status bar.
 * - Renders an amber offline bar with cached/pending counts, "立即同步", and "离线缓存" drawer trigger while disconnected.
 * - Renders a pending-sync bar while online with queued offline mutations awaiting replay.
 * - Renders a brief green confirmation pill for 3.5s after reconnecting.
 * - Returns `null` during normal online usage with zero pending mutations (unless the cache drawer is open).
 */
export function OfflineBanner({
  status,
  offlineState,
  initialDrawerOpen = false,
  initialDrawerTab = "snapshots",
  position = "bottom",
  className,
}: OfflineBannerProps) {
  const { t } = useI18n();
  const liveStatus = useNetworkStatus();
  const liveOffline = useOfflineState();
  const effectiveOffline = offlineState ?? liveOffline;

  const online = status ? status.online : offlineState ? offlineState.online : liveStatus.online;
  const justReconnected = status ? status.justReconnected : liveStatus.justReconnected;

  const [drawerOpen, setDrawerOpen] = useState(initialDrawerOpen);
  const [drawerTab, setDrawerTab] = useState<OfflineCacheTab>(initialDrawerTab);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onOpenDrawer = (event: Event) => {
      const detail = (event as CustomEvent<OfflineCacheTab | undefined>).detail;
      setDrawerTab(detail === "queue" ? "queue" : "snapshots");
      setDrawerOpen(true);
    };
    window.addEventListener(OFFLINE_CACHE_DRAWER_EVENT, onOpenDrawer);
    return () => window.removeEventListener(OFFLINE_CACHE_DRAWER_EVENT, onOpenDrawer);
  }, []);

  const cachedCount = effectiveOffline.cachedSnapshots.length;
  const pendingCount = effectiveOffline.pendingQueue.length;
  const showBanner = !online || justReconnected || pendingCount > 0;

  if (!showBanner && !drawerOpen) {
    return null;
  }

  const drawerOfflineState: OfflineStateHookValue = {
    ...effectiveOffline,
    online,
  };

  const containerClass = cn(
    "pointer-events-none fixed inset-x-0 z-[65] flex justify-center px-4 print:hidden",
    position === "top" ? "top-3" : "bottom-4 safe-area-bottom",
    className,
  );

  const openDrawer = (tab: OfflineCacheTab) => {
    setDrawerTab(tab);
    setDrawerOpen(true);
  };

  const syncButtonDisabled = !online || effectiveOffline.syncing || pendingCount === 0;

  let bannerNode: React.ReactNode = null;

  if (!online) {
    bannerNode = (
      <div className={containerClass}>
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-offline-banner=""
          className="pointer-events-auto inline-flex max-w-[min(780px,calc(100vw-24px))] flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-2xl border border-[#ffd591] bg-[#fff7e6]/95 px-3.5 py-2 text-[13px] font-medium leading-snug text-[#8c4a00] shadow-[0_6px_20px_rgba(31,35,41,0.12)] backdrop-blur-md dark:border-[#6e4b1f] dark:bg-[#2b2215]/95 dark:text-[#ffd591] dark:shadow-[0_6px_20px_rgba(0,0,0,0.4)] sm:rounded-full"
        >
          <span className="inline-flex items-center gap-2">
            <WifiOff
              size={15}
              strokeWidth={2}
              className="shrink-0 text-[#ff8800] dark:text-[#ffb74d]"
              aria-hidden="true"
            />
            <span>{t("网络已断开，本地草稿已暂存，恢复联网后将自动同步")}</span>
          </span>

          <span className="inline-flex flex-wrap items-center gap-1.5 text-[12px]">
            <span className="rounded-full bg-[#ff8800]/12 px-2 py-0.5 text-[#8c4a00] dark:bg-[#ffb74d]/15 dark:text-[#ffd591]">
              {t("已缓存 {n} 项可离线查看", { n: cachedCount })}
            </span>
            {pendingCount > 0 && (
              <span className="rounded-full bg-[#ff8800]/20 px-2 py-0.5 font-semibold text-[#7a3e00] dark:bg-[#ffb74d]/25 dark:text-[#ffe0b2]">
                {t("待同步 {m} 条修改", { m: pendingCount })}
              </span>
            )}
          </span>

          <span className="inline-flex items-center gap-1.5">
            <button
              type="button"
              data-offline-sync-btn=""
              disabled={syncButtonDisabled}
              onClick={() => void effectiveOffline.syncNow()}
              className="inline-flex items-center gap-1 rounded-full border border-[#ff8800]/35 bg-white/80 px-2.5 py-0.5 text-[12px] font-medium text-[#8c4a00] transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-45 dark:border-[#ffb74d]/35 dark:bg-[#3b2d18] dark:text-[#ffd591]"
            >
              <RefreshCw
                size={11}
                className={cn(effectiveOffline.syncing && "animate-spin")}
                aria-hidden="true"
              />
              <span>{t("立即同步")}</span>
            </button>
            <button
              type="button"
              data-offline-drawer-btn=""
              onClick={() => openDrawer("snapshots")}
              className="inline-flex items-center gap-1 rounded-full bg-[#ff8800] px-2.5 py-0.5 text-[12px] font-medium text-white transition-colors hover:bg-[#e67800] dark:bg-[#d97706] dark:hover:bg-[#b45309]"
            >
              <Database size={11} aria-hidden="true" />
              <span>{t("离线缓存")}</span>
            </button>
          </span>
        </div>
      </div>
    );
  } else if (justReconnected) {
    bannerNode = (
      <div className={containerClass}>
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-reconnected-banner=""
          className="pointer-events-auto inline-flex max-w-[min(720px,calc(100vw-24px))] flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-full border border-[#b7eb8f] bg-[#f6ffed]/95 px-3.5 py-2 text-[13px] font-medium leading-snug text-[#135200] shadow-[0_6px_20px_rgba(31,35,41,0.12)] backdrop-blur-md dark:border-[#235d2d] dark:bg-[#132617]/95 dark:text-[#95de64] dark:shadow-[0_6px_20px_rgba(0,0,0,0.4)]"
        >
          <span className="inline-flex items-center gap-2">
            <Wifi
              size={15}
              strokeWidth={2}
              className="shrink-0 text-[#00b42a] dark:text-[#47d16c]"
              aria-hidden="true"
            />
            <span>{t("网络已恢复，正在同步最新内容")}</span>
          </span>

          {pendingCount > 0 && (
            <>
              <span className="rounded-full bg-[#00b42a]/12 px-2 py-0.5 text-[12px] font-semibold">
                {t("待同步 {m} 条修改", { m: pendingCount })}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <button
                  type="button"
                  data-offline-sync-btn=""
                  disabled={syncButtonDisabled}
                  onClick={() => void effectiveOffline.syncNow()}
                  className="inline-flex items-center gap-1 rounded-full bg-[#00b42a] px-2.5 py-0.5 text-[12px] font-medium text-white transition-colors hover:bg-[#009a23] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <RefreshCw
                    size={11}
                    className={cn(effectiveOffline.syncing && "animate-spin")}
                    aria-hidden="true"
                  />
                  <span>{t("立即同步")}</span>
                </button>
                <button
                  type="button"
                  data-offline-drawer-btn=""
                  onClick={() => openDrawer("queue")}
                  className="inline-flex items-center gap-1 rounded-full border border-[#00b42a]/35 bg-white/80 px-2.5 py-0.5 text-[12px] font-medium text-[#135200] transition-colors hover:bg-white dark:border-[#47d16c]/35 dark:bg-[#19351e] dark:text-[#95de64]"
                >
                  <Database size={11} aria-hidden="true" />
                  <span>{t("离线缓存")}</span>
                </button>
              </span>
            </>
          )}
        </div>
      </div>
    );
  } else if (pendingCount > 0) {
    bannerNode = (
      <div className={containerClass}>
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-offline-banner=""
          data-offline-pending-banner=""
          className="pointer-events-auto inline-flex max-w-[min(740px,calc(100vw-24px))] flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-2xl border border-[#bed3ff] bg-[#f0f5ff]/95 px-3.5 py-2 text-[13px] font-medium leading-snug text-[#1456f0] shadow-[0_6px_20px_rgba(31,35,41,0.12)] backdrop-blur-md dark:border-[#2a4a85] dark:bg-[#14233f]/95 dark:text-[#9cbdff] dark:shadow-[0_6px_20px_rgba(0,0,0,0.4)] sm:rounded-full"
        >
          <span className="inline-flex items-center gap-2">
            <RefreshCw
              size={14}
              strokeWidth={2}
              className={cn("shrink-0 text-[#3370ff] dark:text-[#9cbdff]", effectiveOffline.syncing && "animate-spin")}
              aria-hidden="true"
            />
            <span>{t("待同步 {m} 条修改", { m: pendingCount })}</span>
          </span>

          <span className="rounded-full bg-[#3370ff]/10 px-2 py-0.5 text-[12px] dark:bg-[#3370ff]/20">
            {t("已缓存 {n} 项可离线查看", { n: cachedCount })}
          </span>

          <span className="inline-flex items-center gap-1.5">
            <button
              type="button"
              data-offline-sync-btn=""
              disabled={syncButtonDisabled}
              onClick={() => void effectiveOffline.syncNow()}
              className="inline-flex items-center gap-1 rounded-full bg-[#3370ff] px-2.5 py-0.5 text-[12px] font-medium text-white transition-colors hover:bg-[#245bdb] disabled:cursor-not-allowed disabled:opacity-45"
            >
              <RefreshCw
                size={11}
                className={cn(effectiveOffline.syncing && "animate-spin")}
                aria-hidden="true"
              />
              <span>{t("立即同步")}</span>
            </button>
            <button
              type="button"
              data-offline-drawer-btn=""
              onClick={() => openDrawer("queue")}
              className="inline-flex items-center gap-1 rounded-full border border-[#3370ff]/30 bg-white/85 px-2.5 py-0.5 text-[12px] font-medium text-[#1456f0] transition-colors hover:bg-white dark:border-[#3370ff]/40 dark:bg-[#1d3461] dark:text-[#9cbdff]"
            >
              <Database size={11} aria-hidden="true" />
              <span>{t("离线缓存")}</span>
            </button>
          </span>
        </div>
      </div>
    );
  }

  return (
    <>
      {bannerNode}
      <OfflineCacheDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        initialTab={drawerTab}
        offlineState={drawerOfflineState}
      />
    </>
  );
}

export interface OfflineCacheButtonProps {
  /** Optional offline state override (defaults to live `useOfflineState()`). */
  offlineState?: Pick<OfflineStateHookValue, "online" | "cachedSnapshots" | "pendingQueue">;
  /** Compact variant for narrow sidebars or headers. */
  compact?: boolean;
  /** Optional custom click handler (defaults to `openOfflineCacheDrawer()`). */
  onClick?: () => void;
  className?: string;
}

/**
 * Compact Feishu-styled trigger button that opens the offline cache & sync drawer
 * via `openOfflineCacheDrawer()`.
 */
export function OfflineCacheButton({
  offlineState,
  compact = false,
  onClick,
  className,
}: OfflineCacheButtonProps) {
  const { t } = useI18n();
  const liveState = useOfflineState();
  const state = offlineState ?? liveState;
  const cachedCount = state.cachedSnapshots.length;
  const pendingCount = state.pendingQueue.length;

  const handleClick = () => {
    if (onClick) {
      onClick();
      return;
    }
    openOfflineCacheDrawer(pendingCount > 0 ? "queue" : "snapshots");
  };

  return (
    <button
      type="button"
      data-offline-cache-button=""
      onClick={handleClick}
      title={t("离线缓存与同步")}
      aria-label={t("离线缓存与同步")}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3370ff]",
        !state.online
          ? "border-[#ffd591] bg-[#fff7e6] text-[#8c4a00] hover:bg-[#ffe7ba] dark:border-[#6e4b1f] dark:bg-[#2b2215] dark:text-[#ffd591]"
          : pendingCount > 0
            ? "border-[#bed3ff] bg-[#e8f0ff] text-[#1456f0] hover:bg-[#d6e4ff] dark:border-[#2a4a85] dark:bg-[#1d3461] dark:text-[#9cbdff]"
            : "border-[#dee0e3] bg-surface text-muted-foreground hover:bg-hover hover:text-foreground dark:border-border",
        compact ? "px-2.5 py-1 text-[12px]" : "px-3 py-1.5 text-[12.5px]",
        className,
      )}
    >
      {state.online ? (
        <Database size={compact ? 12 : 13} strokeWidth={2} className="shrink-0" aria-hidden="true" />
      ) : (
        <WifiOff size={compact ? 12 : 13} strokeWidth={2} className="shrink-0" aria-hidden="true" />
      )}
      <span>{t("离线缓存")}</span>
      {pendingCount > 0 ? (
        <span
          data-offline-cache-button-pending={pendingCount}
          className="rounded-full bg-[#ff8800] px-1.5 py-0.2 text-[10.5px] font-semibold leading-tight text-white"
        >
          {pendingCount}
        </span>
      ) : cachedCount > 0 ? (
        <span
          data-offline-cache-button-count={cachedCount}
          className="rounded-full bg-black/8 px-1.5 py-0.2 text-[10.5px] leading-tight dark:bg-white/12"
        >
          {cachedCount}
        </span>
      ) : null}
    </button>
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
