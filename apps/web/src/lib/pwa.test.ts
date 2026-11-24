import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RECONNECTED_BANNER_DURATION_MS,
  createNetworkStatusController,
  createPwaInstallController,
  registerServiceWorker,
  type BeforeInstallPromptEvent,
} from "./pwa";

const webRoot = fileURLToPath(new URL("../..", import.meta.url));
const readWebFile = (relPath: string) => readFileSync(join(webRoot, relPath), "utf8");

class MockEventTarget {
  private listeners = new Map<string, Set<{ fn: EventListenerOrEventListenerObject; once: boolean }>>();

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (!listener) return;
    const once = typeof options === "object" && Boolean(options?.once);
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add({ fn: listener, once });
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (!listener) return;
    const set = this.listeners.get(type);
    if (!set) return;
    for (const entry of set) {
      if (entry.fn === listener) {
        set.delete(entry);
      }
    }
  }

  dispatch(type: string, event: Event = new Event(type)) {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const entry of [...set]) {
      if (entry.once) set.delete(entry);
      if (typeof entry.fn === "function") {
        entry.fn(event);
      } else {
        entry.fn.handleEvent(event);
      }
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

interface MockResponseLike {
  url?: string;
  status: number;
  ok: boolean;
  type: string;
  body: string;
  headers: Headers;
  clone: () => MockResponseLike;
}

function makeMockResponse(
  body: string,
  init: { status?: number; type?: string; headers?: Record<string, string> } = {},
): MockResponseLike {
  const status = init.status ?? 200;
  const type = init.type ?? "basic";
  const headers = new Headers(init.headers ?? {});
  const resp: MockResponseLike = {
    status,
    ok: status >= 200 && status < 300,
    type,
    body,
    headers,
    clone: () => makeMockResponse(body, { status, type, headers: Object.fromEntries(headers.entries()) }),
  };
  return resp;
}

function createSwSandbox(initialCaches: Record<string, Record<string, MockResponseLike>> = {}) {
  const store = new Map<string, Map<string, MockResponseLike>>();
  for (const [cacheName, entries] of Object.entries(initialCaches)) {
    store.set(cacheName, new Map(Object.entries(entries)));
  }

  const normalizeKey = (req: string | { url: string }) => {
    const raw = typeof req === "string" ? req : req.url;
    const u = new URL(raw, "https://jiange.example");
    return `${u.pathname}${u.search}`;
  };

  const fetchMock = vi.fn(async (input: string | { url: string }) => {
    const key = normalizeKey(input);
    return makeMockResponse(`network:${key}`, {
      status: 200,
      type: "basic",
      headers: key === "/" ? { "content-type": "text/html; charset=utf-8" } : {},
    });
  });

  const cachesMock = {
    open: vi.fn(async (name: string) => {
      let map = store.get(name);
      if (!map) {
        map = new Map();
        store.set(name, map);
      }
      return {
        addAll: vi.fn(async (urls: string[]) => {
          for (const url of urls) {
            const resp = await fetchMock(url);
            map!.set(normalizeKey(url), resp);
          }
        }),
        match: vi.fn(async (req: string | { url: string }) => map!.get(normalizeKey(req))),
        put: vi.fn(async (req: string | { url: string }, resp: MockResponseLike) => {
          map!.set(normalizeKey(req), resp);
        }),
      };
    }),
    keys: vi.fn(async () => [...store.keys()]),
    delete: vi.fn(async (name: string) => store.delete(name)),
  };

  const handlers = new Map<string, Array<(event: unknown) => void>>();
  const skipWaiting = vi.fn(async () => {});
  const claim = vi.fn(async () => {});

  const selfObj = {
    location: new URL("https://jiange.example/sw.js"),
    addEventListener: (type: string, cb: (event: unknown) => void) => {
      const list = handlers.get(type) ?? [];
      list.push(cb);
      handlers.set(type, list);
    },
    skipWaiting,
    clients: { claim },
  };

  const swSource = readWebFile("public/sw.js");
  vm.runInNewContext(swSource, {
    self: selfObj,
    caches: cachesMock,
    fetch: fetchMock,
    URL,
    Response,
    Headers,
  });

  const dispatchLifecycle = async (type: "install" | "activate") => {
    const promises: Promise<unknown>[] = [];
    for (const fn of handlers.get(type) ?? []) {
      fn({ waitUntil: (p: Promise<unknown>) => promises.push(p) });
    }
    await Promise.all(promises);
  };

  const dispatchFetch = async (request: {
    url: string;
    method?: string;
    mode?: string;
    headers?: Record<string, string>;
  }) => {
    let responded = false;
    let responsePromise: Promise<unknown> | null = null;
    const waitPromises: Promise<unknown>[] = [];
    const reqObj = {
      url: request.url,
      method: request.method ?? "GET",
      mode: request.mode ?? "cors",
      headers: new Headers(request.headers ?? {}),
    };
    for (const fn of handlers.get("fetch") ?? []) {
      fn({
        request: reqObj,
        respondWith: (p: Promise<unknown>) => {
          responded = true;
          responsePromise = p;
        },
        waitUntil: (p: Promise<unknown>) => {
          waitPromises.push(p);
        },
      });
    }
    const response = responsePromise ? await responsePromise : undefined;
    await Promise.all(waitPromises);
    return { responded, response: response as MockResponseLike | Response | undefined };
  };

  return { store, fetchMock, cachesMock, skipWaiting, claim, dispatchLifecycle, dispatchFetch };
}

describe("PWA Manifest, Brand Icons, and index.html", () => {
  it("provides a valid manifest.webmanifest with Jiange metadata and brand icons", () => {
    const raw = readWebFile("public/manifest.webmanifest");
    const manifest = JSON.parse(raw) as {
      name: string;
      short_name: string;
      start_url: string;
      scope: string;
      display: string;
      background_color: string;
      theme_color: string;
      icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
    };

    expect(manifest.name).toBe("Jiange 剑阁协作空间");
    expect(manifest.short_name).toBe("Jiange");
    expect(manifest.start_url).toBe("/#/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.background_color).toBe("#ffffff");
    expect(manifest.theme_color).toBe("#3370ff");
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ src: "/brand/icon-192.svg", sizes: "192x192", type: "image/svg+xml" }),
        expect.objectContaining({ src: "/brand/icon-512.svg", sizes: "512x512", type: "image/svg+xml" }),
      ]),
    );

    const icon192 = readWebFile("public/brand/icon-192.svg");
    const icon512 = readWebFile("public/brand/icon-512.svg");
    expect(icon192).toContain("<svg");
    expect(icon192).toContain('viewBox="0 0 192 192"');
    expect(icon192).toContain("#3370ff");
    expect(icon512).toContain("<svg");
    expect(icon512).toContain('viewBox="0 0 512 512"');
    expect(icon512).toContain("#3370ff");
  });

  it("links manifest, theme-color, and apple-mobile-web-app-capable in index.html without breaking existing tags", () => {
    const html = readWebFile("index.html");
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(html).toContain('<meta name="theme-color" content="#3370ff" />');
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
    // Existing tags remain intact
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="%BASE_URL%brand/jiange-mark.svg" />');
    expect(html).toContain('<link rel="apple-touch-icon" sizes="180x180" href="%BASE_URL%brand/jiange-apple-touch-icon.png" />');
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('<script type="module" src="/src/main.tsx"></script>');
  });
});

describe("Production Service Worker (public/sw.js)", () => {
  it("pre-caches app shell on install and activates by pruning old jiange-shell-* caches", async () => {
    const sw = createSwSandbox({
      "jiange-shell-v0": { "/": makeMockResponse("old-shell") },
      "jiange-shell-legacy": { "/": makeMockResponse("legacy-shell") },
      "unrelated-cache-v1": { "/foo": makeMockResponse("keep-me") },
    });

    await sw.dispatchLifecycle("install");
    expect(sw.skipWaiting).toHaveBeenCalledTimes(1);
    const v1 = sw.store.get("jiange-shell-v1");
    expect(v1?.has("/")).toBe(true);
    expect(v1?.has("/manifest.webmanifest")).toBe(true);
    expect(v1?.has("/brand/icon-192.svg")).toBe(true);

    await sw.dispatchLifecycle("activate");
    expect(sw.claim).toHaveBeenCalledTimes(1);
    expect(sw.store.has("jiange-shell-v0")).toBe(false);
    expect(sw.store.has("jiange-shell-legacy")).toBe(false);
    expect(sw.store.has("jiange-shell-v1")).toBe(true);
    expect(sw.store.has("unrelated-cache-v1")).toBe(true);
  });

  it("NEVER intercepts or caches /api/, WebSockets, non-GET, cross-origin, or /sw.js requests", async () => {
    const sw = createSwSandbox({
      "jiange-shell-v1": { "/": makeMockResponse("cached-shell") },
    });

    const bypassCases = [
      { url: "https://jiange.example/api/me", method: "GET" },
      { url: "https://jiange.example/api/docs/42", method: "GET" },
      { url: "https://jiange.example/api", method: "GET" },
      { url: "https://jiange.example/api/sso/login", method: "GET", mode: "navigate" },
      { url: "https://jiange.example/api/sync/doc/1", method: "GET", headers: { upgrade: "websocket" } },
      { url: "wss://jiange.example/api/sync/doc/1", method: "GET" },
      { url: "ws://jiange.example/api/sheets/1/ws", method: "GET" },
      { url: "https://jiange.example/assets/app.js", method: "POST" },
      { url: "https://jiange.example/brand/icon-192.svg", method: "DELETE" },
      { url: "https://cdn.external.test/assets/app-123.js", method: "GET" },
      { url: "https://cdn.external.test/", method: "GET", mode: "navigate" },
      { url: "https://jiange.example/sw.js", method: "GET" },
      { url: "https://jiange.example/healthz", method: "GET" },
    ];

    for (const req of bypassCases) {
      const result = await sw.dispatchFetch(req);
      expect(result.responded, `should bypass ${req.method} ${req.url}`).toBe(false);
    }

    expect(sw.fetchMock).not.toHaveBeenCalled();
    const v1Keys = [...(sw.store.get("jiange-shell-v1")?.keys() ?? [])];
    expect(v1Keys.some((k) => k.startsWith("/api"))).toBe(false);
  });

  it("uses cache-first with background cache fill for /assets/* and /brand/*", async () => {
    const sw = createSwSandbox({ "jiange-shell-v1": {} });

    // Cache miss -> fetches from network and populates cache
    const miss = await sw.dispatchFetch({ url: "https://jiange.example/assets/index-abc123.js" });
    expect(miss.responded).toBe(true);
    expect((miss.response as MockResponseLike).body).toBe("network:/assets/index-abc123.js");
    expect(sw.fetchMock).toHaveBeenCalledTimes(1);
    expect(sw.store.get("jiange-shell-v1")?.has("/assets/index-abc123.js")).toBe(true);

    // Cache hit -> serves cached copy without network call
    sw.fetchMock.mockClear();
    const hit = await sw.dispatchFetch({ url: "https://jiange.example/assets/index-abc123.js" });
    expect(hit.responded).toBe(true);
    expect((hit.response as MockResponseLike).body).toBe("network:/assets/index-abc123.js");
    expect(sw.fetchMock).not.toHaveBeenCalled();

    // Brand asset also uses cache-first
    const brandMiss = await sw.dispatchFetch({ url: "https://jiange.example/brand/icon-512.svg" });
    expect(brandMiss.responded).toBe(true);
    expect(sw.store.get("jiange-shell-v1")?.has("/brand/icon-512.svg")).toBe(true);
  });

  it("uses network-first with cached / fallback for HTML navigation requests", async () => {
    const sw = createSwSandbox({
      "jiange-shell-v1": { "/": makeMockResponse("<html>cached-shell</html>") },
    });

    // Online navigation returns fresh HTML and updates cached shell
    const online = await sw.dispatchFetch({
      url: "https://jiange.example/",
      method: "GET",
      mode: "navigate",
    });
    expect(online.responded).toBe(true);
    expect((online.response as MockResponseLike).body).toBe("network:/");
    expect(sw.store.get("jiange-shell-v1")?.get("/")?.body).toBe("network:/");

    // Offline navigation falls back to cached /
    sw.fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const offline = await sw.dispatchFetch({
      url: "https://jiange.example/",
      method: "GET",
      mode: "navigate",
    });
    expect(offline.responded).toBe(true);
    expect((offline.response as MockResponseLike).body).toBe("network:/");
  });
});

describe("registerServiceWorker", () => {
  it("does not register in non-production builds (protects Vite HMR dev server)", async () => {
    const register = vi.fn();
    const reg = await registerServiceWorker({
      prod: false,
      navigator: { serviceWorker: { register } },
    });
    expect(reg).toBeNull();
    expect(register).not.toHaveBeenCalled();
  });

  it("returns null safely when navigator.serviceWorker is unavailable", async () => {
    const reg1 = await registerServiceWorker({ prod: true, navigator: {} });
    const reg2 = await registerServiceWorker({ prod: true, navigator: null });
    expect(reg1).toBeNull();
    expect(reg2).toBeNull();
  });

  it("registers /sw.js in production when document is already complete", async () => {
    const mockReg = { scope: "https://jiange.example/" } as ServiceWorkerRegistration;
    const register = vi.fn().mockResolvedValue(mockReg);
    const result = await registerServiceWorker({
      prod: true,
      navigator: { serviceWorker: { register } },
      readyState: "complete",
    });
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
    expect(result).toBe(mockReg);
  });

  it("defers registration until window load when document is still loading", async () => {
    const win = new MockEventTarget();
    const mockReg = { scope: "https://jiange.example/" } as ServiceWorkerRegistration;
    const register = vi.fn().mockResolvedValue(mockReg);

    const pending = registerServiceWorker({
      prod: true,
      navigator: { serviceWorker: { register } },
      window: win,
      readyState: "loading",
    });

    expect(register).not.toHaveBeenCalled();
    win.dispatch("load");
    const result = await pending;
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
    expect(result).toBe(mockReg);
  });

  it("swallows registration errors cleanly and resolves to null", async () => {
    const register = vi.fn().mockRejectedValue(new Error("SecurityError"));
    const result = await registerServiceWorker({
      prod: true,
      navigator: { serviceWorker: { register } },
      readyState: "complete",
    });
    expect(result).toBeNull();
  });
});

describe("createNetworkStatusController (useNetworkStatus)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("tracks online -> offline -> online with a 3.5s justReconnected window", () => {
    vi.useFakeTimers();
    const win = new MockEventTarget();
    const ctrl = createNetworkStatusController({
      window: win,
      navigator: { onLine: true },
    });
    const snapshots: Array<{ online: boolean; justReconnected: boolean }> = [];
    ctrl.subscribe(() => snapshots.push(ctrl.getSnapshot()));
    const stop = ctrl.start();

    expect(ctrl.getSnapshot()).toEqual({ online: true, justReconnected: false });

    // Spurious online while already online should not trigger reconnected banner
    win.dispatch("online");
    expect(ctrl.getSnapshot()).toEqual({ online: true, justReconnected: false });
    expect(snapshots).toHaveLength(0);

    // Go offline
    win.dispatch("offline");
    expect(ctrl.getSnapshot()).toEqual({ online: false, justReconnected: false });

    // Come back online -> justReconnected active for 3500ms
    win.dispatch("online");
    expect(ctrl.getSnapshot()).toEqual({ online: true, justReconnected: true });

    vi.advanceTimersByTime(RECONNECTED_BANNER_DURATION_MS - 1);
    expect(ctrl.getSnapshot()).toEqual({ online: true, justReconnected: true });

    vi.advanceTimersByTime(1);
    expect(ctrl.getSnapshot()).toEqual({ online: true, justReconnected: false });

    stop();
    expect(win.listenerCount("online")).toBe(0);
    expect(win.listenerCount("offline")).toBe(0);
  });

  it("cancels the reconnected timer if connectivity drops again within 3.5s", () => {
    vi.useFakeTimers();
    const win = new MockEventTarget();
    const ctrl = createNetworkStatusController({
      window: win,
      navigator: { onLine: false },
    });
    const stop = ctrl.start();

    expect(ctrl.getSnapshot()).toEqual({ online: false, justReconnected: false });

    win.dispatch("online");
    expect(ctrl.getSnapshot()).toEqual({ online: true, justReconnected: true });

    vi.advanceTimersByTime(1000);
    win.dispatch("offline");
    expect(ctrl.getSnapshot()).toEqual({ online: false, justReconnected: false });

    vi.advanceTimersByTime(RECONNECTED_BANNER_DURATION_MS);
    expect(ctrl.getSnapshot()).toEqual({ online: false, justReconnected: false });

    stop();
  });
});

describe("createPwaInstallController (usePwaInstallPrompt)", () => {
  function makeInstallEvent(outcome: "accepted" | "dismissed" = "accepted") {
    const prompt = vi.fn(async () => {});
    const event = new Event("beforeinstallprompt", { cancelable: true }) as BeforeInstallPromptEvent;
    Object.defineProperties(event, {
      platforms: { value: ["web"] },
      prompt: { value: prompt },
      userChoice: { value: Promise.resolve({ outcome, platform: "web" }) },
    });
    return { event, prompt };
  }

  it("captures beforeinstallprompt, prompts once, and clears canInstall", async () => {
    const win = new MockEventTarget();
    const ctrl = createPwaInstallController({ window: win, navigator: {} });
    const stop = ctrl.start();

    expect(ctrl.getCanInstall()).toBe(false);
    expect(await ctrl.promptInstall()).toBe("unavailable");

    const { event, prompt } = makeInstallEvent("accepted");
    win.dispatch("beforeinstallprompt", event);

    expect(event.defaultPrevented).toBe(true);
    expect(ctrl.getCanInstall()).toBe(true);

    const outcome = await ctrl.promptInstall();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(outcome).toBe("accepted");
    expect(ctrl.getCanInstall()).toBe(false);
    // Deferred prompt can only be consumed once
    expect(await ctrl.promptInstall()).toBe("unavailable");

    stop();
    expect(win.listenerCount("beforeinstallprompt")).toBe(0);
    expect(win.listenerCount("appinstalled")).toBe(0);
  });

  it("supports dismiss() and clears canInstall on appinstalled", () => {
    const win = new MockEventTarget();
    const ctrl = createPwaInstallController({ window: win, navigator: {} });
    const stop = ctrl.start();

    const first = makeInstallEvent("dismissed");
    win.dispatch("beforeinstallprompt", first.event);
    expect(ctrl.getCanInstall()).toBe(true);

    ctrl.dismiss();
    expect(ctrl.getCanInstall()).toBe(false);

    // Subsequent beforeinstallprompt in same dismissed session stays hidden
    const second = makeInstallEvent("accepted");
    win.dispatch("beforeinstallprompt", second.event);
    expect(ctrl.getCanInstall()).toBe(false);
    stop();

    // Fresh controller clears on appinstalled
    const ctrl2 = createPwaInstallController({ window: win, navigator: {} });
    const stop2 = ctrl2.start();
    win.dispatch("beforeinstallprompt", makeInstallEvent("accepted").event);
    expect(ctrl2.getCanInstall()).toBe(true);
    win.dispatch("appinstalled");
    expect(ctrl2.getCanInstall()).toBe(false);
    stop2();
  });

  it("stays hidden when already running in standalone mode", () => {
    const win = new MockEventTarget();
    const ctrl = createPwaInstallController({
      window: Object.assign(win, {
        matchMedia: () => ({ matches: true }) as MediaQueryList,
      }),
      navigator: {},
    });
    const stop = ctrl.start();

    win.dispatch("beforeinstallprompt", makeInstallEvent("accepted").event);
    expect(ctrl.getCanInstall()).toBe(false);
    stop();
  });
});
