import { useCallback, useEffect, useState } from "react";

export const SERVICE_WORKER_URL = "/sw.js";
export const RECONNECTED_BANNER_DURATION_MS = 3500;

export interface NetworkStatus {
  online: boolean;
  justReconnected: boolean;
}

export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt(): Promise<void>;
}

export type PwaInstallOutcome = "accepted" | "dismissed" | "unavailable";

export interface PwaInstallPromptState {
  canInstall: boolean;
  promptInstall: () => Promise<PwaInstallOutcome>;
  dismiss: () => void;
}

type EventTargetLike = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export interface RegisterServiceWorkerOptions {
  /** Override `import.meta.env.PROD` (primarily for tests). */
  prod?: boolean;
  /** Override `navigator` (primarily for tests). */
  navigator?: { serviceWorker?: Pick<ServiceWorkerContainer, "register"> } | null;
  /** Override `window` for deferred `load` listener (primarily for tests). */
  window?: EventTargetLike | null;
  /** Override `document.readyState` (primarily for tests). */
  readyState?: DocumentReadyState;
  /** Service worker script URL (defaults to `/sw.js`). */
  swUrl?: string;
  /** Service worker scope (defaults to `/`). */
  scope?: string;
}

function resolveServiceWorkerUrl(): string {
  const base = import.meta.env?.BASE_URL ?? "/";
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  return `${normalizedBase}sw.js`;
}

/**
 * Registers the production app-shell service worker (`/sw.js`).
 * Strictly a no-op in non-production builds so Vite HMR is never affected.
 */
export function registerServiceWorker(
  options?: RegisterServiceWorkerOptions,
): Promise<ServiceWorkerRegistration | null> {
  const isProd = options?.prod ?? Boolean(import.meta.env?.PROD);
  if (!isProd) {
    return Promise.resolve(null);
  }

  const nav =
    options && "navigator" in options
      ? options.navigator
      : typeof navigator !== "undefined"
        ? navigator
        : null;

  if (!nav || !("serviceWorker" in nav) || !nav.serviceWorker || typeof nav.serviceWorker.register !== "function") {
    return Promise.resolve(null);
  }

  const swUrl = options?.swUrl ?? resolveServiceWorkerUrl();
  const scope = options?.scope ?? "/";

  const doRegister = async (): Promise<ServiceWorkerRegistration | null> => {
    try {
      return await nav.serviceWorker!.register(swUrl, { scope });
    } catch {
      return null;
    }
  };

  const win =
    options && "window" in options
      ? options.window
      : typeof window !== "undefined"
        ? window
        : null;
  const readyState =
    options?.readyState ?? (typeof document !== "undefined" ? document.readyState : "complete");

  if (win && readyState !== "complete") {
    return new Promise((resolve) => {
      const onLoad = () => {
        win.removeEventListener("load", onLoad);
        void doRegister().then(resolve);
      };
      win.addEventListener("load", onLoad, { once: true });
    });
  }

  return doRegister();
}

function readNavigatorOnline(nav?: { onLine?: boolean } | null): boolean {
  const target = nav !== undefined ? nav : typeof navigator !== "undefined" ? navigator : null;
  if (target && typeof target.onLine === "boolean") {
    return target.onLine;
  }
  return true;
}

export interface NetworkStatusControllerOptions {
  window?: EventTargetLike | null;
  navigator?: { onLine?: boolean } | null;
  reconnectDurationMs?: number;
}

export interface NetworkStatusController {
  getSnapshot: () => NetworkStatus;
  subscribe: (listener: () => void) => () => void;
  start: () => () => void;
}

/**
 * Pure controller backing `useNetworkStatus()`.
 * Listens to `online` / `offline` events and emits a brief `justReconnected` window
 * after transitioning from offline back to online.
 */
export function createNetworkStatusController(
  options?: NetworkStatusControllerOptions,
): NetworkStatusController {
  const win =
    options && "window" in options
      ? options.window
      : typeof window !== "undefined"
        ? window
        : null;
  const nav =
    options && "navigator" in options
      ? options.navigator
      : typeof navigator !== "undefined"
        ? navigator
        : null;
  const reconnectDurationMs = options?.reconnectDurationMs ?? RECONNECTED_BANNER_DURATION_MS;

  let snapshot: NetworkStatus = {
    online: readNavigatorOnline(nav),
    justReconnected: false,
  };
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const clearTimer = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const update = (next: NetworkStatus) => {
    if (snapshot.online === next.online && snapshot.justReconnected === next.justReconnected) {
      return;
    }
    snapshot = next;
    emit();
  };

  const handleOffline = () => {
    clearTimer();
    update({ online: false, justReconnected: false });
  };

  const handleOnline = () => {
    if (snapshot.online) {
      return;
    }
    clearTimer();
    update({ online: true, justReconnected: true });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (snapshot.online && snapshot.justReconnected) {
        update({ online: true, justReconnected: false });
      }
    }, reconnectDurationMs);
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: () => {
      if (!win) {
        return () => {
          clearTimer();
        };
      }
      win.addEventListener("online", handleOnline);
      win.addEventListener("offline", handleOffline);
      return () => {
        win.removeEventListener("online", handleOnline);
        win.removeEventListener("offline", handleOffline);
        clearTimer();
      };
    },
  };
}

/**
 * Tracks browser online/offline state with a brief 3.5s `justReconnected` confirmation window.
 */
export function useNetworkStatus(
  reconnectDurationMs: number = RECONNECTED_BANNER_DURATION_MS,
): NetworkStatus {
  const [status, setStatus] = useState<NetworkStatus>(() => ({
    online: readNavigatorOnline(),
    justReconnected: false,
  }));

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const controller = createNetworkStatusController({
      window,
      navigator: typeof navigator !== "undefined" ? navigator : null,
      reconnectDurationMs,
    });
    const sync = () => {
      const next = controller.getSnapshot();
      setStatus((prev) =>
        prev.online === next.online && prev.justReconnected === next.justReconnected ? prev : next,
      );
    };
    sync();
    const unsubscribe = controller.subscribe(sync);
    const stop = controller.start();
    return () => {
      unsubscribe();
      stop();
    };
  }, [reconnectDurationMs]);

  return status;
}

export interface PwaInstallControllerOptions {
  window?: (EventTargetLike & { matchMedia?: Window["matchMedia"] }) | null;
  navigator?: { standalone?: boolean } | null;
}

export interface PwaInstallController {
  getCanInstall: () => boolean;
  promptInstall: () => Promise<PwaInstallOutcome>;
  dismiss: () => void;
  subscribe: (listener: () => void) => () => void;
  start: () => () => void;
}

function isStandaloneMode(
  win?: { matchMedia?: Window["matchMedia"] } | null,
  nav?: { standalone?: boolean } | null,
): boolean {
  if (nav?.standalone === true) {
    return true;
  }
  try {
    return Boolean(win?.matchMedia?.("(display-mode: standalone)")?.matches);
  } catch {
    return false;
  }
}

function isBeforeInstallPromptEvent(event: Event): event is BeforeInstallPromptEvent {
  return (
    typeof (event as Partial<BeforeInstallPromptEvent>).prompt === "function" &&
    "userChoice" in event
  );
}

/**
 * Pure controller backing `usePwaInstallPrompt()`.
 * Captures `beforeinstallprompt`, suppresses the default mini-infobar, and exposes
 * one-shot `promptInstall()` and `dismiss()` controls.
 */
export function createPwaInstallController(
  options?: PwaInstallControllerOptions,
): PwaInstallController {
  const win =
    options && "window" in options
      ? options.window
      : typeof window !== "undefined"
        ? window
        : null;
  const nav =
    options && "navigator" in options
      ? options.navigator
      : typeof navigator !== "undefined"
        ? (navigator as Navigator & { standalone?: boolean })
        : null;

  let deferredPrompt: BeforeInstallPromptEvent | null = null;
  let dismissed = false;
  let canInstall = false;
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const setCanInstall = (next: boolean) => {
    if (canInstall === next) return;
    canInstall = next;
    emit();
  };

  const handleBeforeInstallPrompt = (event: Event) => {
    if (!isBeforeInstallPromptEvent(event)) {
      return;
    }
    event.preventDefault();
    if (dismissed || isStandaloneMode(win, nav)) {
      deferredPrompt = null;
      setCanInstall(false);
      return;
    }
    deferredPrompt = event;
    setCanInstall(true);
  };

  const handleAppInstalled = () => {
    deferredPrompt = null;
    setCanInstall(false);
  };

  const promptInstall = async (): Promise<PwaInstallOutcome> => {
    const promptEvent = deferredPrompt;
    if (!promptEvent) {
      setCanInstall(false);
      return "unavailable";
    }
    deferredPrompt = null;
    setCanInstall(false);
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      return choice.outcome === "accepted" ? "accepted" : "dismissed";
    } catch {
      return "dismissed";
    }
  };

  const dismiss = () => {
    dismissed = true;
    deferredPrompt = null;
    setCanInstall(false);
  };

  return {
    getCanInstall: () => canInstall,
    promptInstall,
    dismiss,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: () => {
      if (!win) {
        return () => {};
      }
      win.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      win.addEventListener("appinstalled", handleAppInstalled);
      return () => {
        win.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
        win.removeEventListener("appinstalled", handleAppInstalled);
      };
    },
  };
}

const sharedInstallControllers = new WeakMap<EventTargetLike, PwaInstallController>();

function getBrowserInstallController(): PwaInstallController | null {
  if (typeof window === "undefined") {
    return null;
  }
  let controller = sharedInstallControllers.get(window);
  if (!controller) {
    controller = createPwaInstallController({
      window,
      navigator: typeof navigator !== "undefined" ? (navigator as Navigator & { standalone?: boolean }) : null,
    });
    controller.start();
    sharedInstallControllers.set(window, controller);
  }
  return controller;
}

// Capture early browser `beforeinstallprompt` events before authenticated UI mounts.
if (typeof window !== "undefined") {
  getBrowserInstallController();
}

/**
 * Listens for browser PWA install availability (`beforeinstallprompt`) and exposes
 * `{ canInstall, promptInstall, dismiss }`.
 */
export function usePwaInstallPrompt(): PwaInstallPromptState {
  const [canInstall, setCanInstall] = useState<boolean>(
    () => getBrowserInstallController()?.getCanInstall() ?? false,
  );

  useEffect(() => {
    const controller = getBrowserInstallController();
    if (!controller) {
      return;
    }
    const sync = () => {
      setCanInstall(controller.getCanInstall());
    };
    sync();
    return controller.subscribe(sync);
  }, []);

  const promptInstall = useCallback(async (): Promise<PwaInstallOutcome> => {
    const controller = getBrowserInstallController();
    if (!controller) {
      return "unavailable";
    }
    return controller.promptInstall();
  }, []);

  const dismiss = useCallback(() => {
    getBrowserInstallController()?.dismiss();
  }, []);

  return { canInstall, promptInstall, dismiss };
}
