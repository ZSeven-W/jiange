import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLAYGROUND_DIR = path.resolve(__dirname);
const REPO_ROOT = path.resolve(PLAYGROUND_DIR, "..", "..");
const PACKAGES_DIR = path.resolve(REPO_ROOT, "packages");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT) || 4173;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const ROOT_FILES = new Map([
  ["/", path.join(PLAYGROUND_DIR, "index.html")],
  ["/index.html", path.join(PLAYGROUND_DIR, "index.html")],
  ["/app.mjs", path.join(PLAYGROUND_DIR, "app.mjs")],
  ["/styles.css", path.join(PLAYGROUND_DIR, "styles.css")],
]);

const PKG_NAME_RE = /^[a-z0-9-]+$/;

function resolveRequestFile(rawUrl) {
  let pathname;
  try {
    const parsed = new URL(rawUrl, `http://${HOST}:${PORT}`);
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return { status: 400, error: "Malformed request URL" };
  }

  if (pathname.includes("\0") || pathname.includes("\\")) {
    return { status: 403, error: "Forbidden path" };
  }

  const rootTarget = ROOT_FILES.get(pathname);
  if (rootTarget) {
    return { status: 200, filePath: rootTarget };
  }

  if (pathname.startsWith("/packages/")) {
    const segments = pathname.slice("/packages/".length).split("/");
    if (segments.length < 3 || segments.some((s) => s === "" || s === "." || s === "..")) {
      return { status: 403, error: "Forbidden path" };
    }
    const [pkgName, distSeg, ...rest] = segments;
    if (!PKG_NAME_RE.test(pkgName) || distSeg !== "dist") {
      return { status: 403, error: "Only /packages/<pkg>/dist/<file> is exposed" };
    }

    const allowedDistDir = path.resolve(PACKAGES_DIR, pkgName, "dist");
    if (!allowedDistDir.startsWith(PACKAGES_DIR + path.sep)) {
      return { status: 403, error: "Forbidden package path" };
    }

    const candidate = path.resolve(allowedDistDir, ...rest);
    if (!candidate.startsWith(allowedDistDir + path.sep)) {
      return { status: 403, error: "Path traversal blocked" };
    }

    return { status: 200, filePath: candidate };
  }

  return { status: 404, error: "Not found" };
}

function sendError(res, status, message, method) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(method === "HEAD" ? undefined : `${status} ${message}\n`);
}

const server = http.createServer((req, res) => {
  const method = req.method || "GET";
  if (method !== "GET" && method !== "HEAD") {
    sendError(res, 405, "Method Not Allowed", method);
    return;
  }

  const resolved = resolveRequestFile(req.url || "/");
  if (resolved.status !== 200 || !resolved.filePath) {
    sendError(res, resolved.status, resolved.error || "Error", method);
    return;
  }

  fs.stat(resolved.filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      sendError(res, 404, "Not Found", method);
      return;
    }

    const ext = path.extname(resolved.filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stat.size,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });

    if (method === "HEAD") {
      res.end();
      return;
    }

    const stream = fs.createReadStream(resolved.filePath);
    stream.on("error", () => {
      if (!res.headersSent) {
        sendError(res, 500, "Internal Server Error", method);
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Jiange UI Playground listening on http://${HOST}:${PORT}`);
});
