/* Jiange Production Service Worker — App Shell & Immutable Static Assets Only */

const CACHE_PREFIX = "jiange-shell-";
const CACHE_NAME = "jiange-shell-v1";
const SHELL_URLS = ["/", "/manifest.webmanifest", "/brand/icon-192.svg"];

function isCacheableResponse(response) {
  return Boolean(response && response.ok && response.status === 200 && response.type === "basic");
}

function isApiPath(pathname) {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function isStaticAssetPath(pathname) {
  return pathname.startsWith("/assets/") || pathname.startsWith("/brand/");
}

function isWebSocketRequest(request, url) {
  if (url.protocol === "ws:" || url.protocol === "wss:") return true;
  const upgrade = request.headers && typeof request.headers.get === "function" ? request.headers.get("upgrade") : null;
  return Boolean(upgrade && upgrade.toLowerCase() === "websocket");
}

function shouldBypass(request, url) {
  // Never intercept non-GET requests (mutations, uploads, auth posts).
  if (request.method !== "GET") return true;
  // Never intercept WebSockets or non-HTTP(S) schemes.
  if (isWebSocketRequest(request, url)) return true;
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  // Never intercept cross-origin requests.
  if (url.origin !== self.location.origin) return true;
  // Never intercept or cache any /api/ endpoints (prevents leaking authenticated session data).
  if (isApiPath(url.pathname)) return true;
  // Never intercept the service worker script itself or health probes.
  if (url.pathname === "/sw.js" || url.pathname === "/healthz") return true;
  return false;
}

async function cacheFirstAsset(request, event) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }
  const response = await fetch(request);
  if (isCacheableResponse(response)) {
    const putPromise = cache.put(request, response.clone()).catch(() => {});
    if (event && typeof event.waitUntil === "function") {
      event.waitUntil(putPromise);
    }
  }
  return response;
}

async function networkFirstNavigation(request, url, event) {
  try {
    const response = await fetch(request);
    if (isCacheableResponse(response) && (url.pathname === "/" || url.pathname === "/index.html")) {
      const contentType =
        response.headers && typeof response.headers.get === "function" ? response.headers.get("content-type") : null;
      if (!contentType || contentType.toLowerCase().includes("text/html")) {
        const clone = response.clone();
        const putPromise = caches
          .open(CACHE_NAME)
          .then((cache) => cache.put("/", clone))
          .catch(() => {});
        if (event && typeof event.waitUntil === "function") {
          event.waitUntil(putPromise);
        }
      }
    }
    return response;
  } catch {
    const cache = await caches.open(CACHE_NAME);
    const fallback = (await cache.match("/")) || (await cache.match("/index.html"));
    if (fallback) {
      return fallback;
    }
    return new Response("Offline", {
      status: 503,
      statusText: "Service Unavailable",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

async function networkFirstManifest(request, event) {
  try {
    const response = await fetch(request);
    if (isCacheableResponse(response)) {
      const clone = response.clone();
      const putPromise = caches
        .open(CACHE_NAME)
        .then((cache) => cache.put(request, clone))
        .catch(() => {});
      if (event && typeof event.waitUntil === "function") {
        event.waitUntil(putPromise);
      }
    }
    return response;
  } catch {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response("Offline", { status: 503, statusText: "Service Unavailable" });
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  let url;
  try {
    url = new URL(request.url, self.location.origin);
  } catch {
    return;
  }

  if (shouldBypass(request, url)) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request, url, event));
    return;
  }

  if (isStaticAssetPath(url.pathname)) {
    event.respondWith(cacheFirstAsset(request, event));
    return;
  }

  if (url.pathname === "/manifest.webmanifest") {
    event.respondWith(networkFirstManifest(request, event));
  }
});
