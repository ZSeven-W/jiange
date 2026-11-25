/// <reference types="vitest" />
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replace(/\\/g, "/");
          if (normalized.includes("/node_modules/")) {
            if (/\/node_modules\/(react|react-dom|scheduler)\//.test(normalized)) {
              return "vendor-react";
            }
            if (normalized.includes("/node_modules/@tanstack/")) {
              return "vendor-query";
            }
            if (normalized.includes("/node_modules/lucide-react/")) {
              return "vendor-lucide";
            }
            if (normalized.includes("/node_modules/parse5/")) {
              return "vendor-parse5";
            }
            if (normalized.includes("/node_modules/qrcode.react/")) {
              return "vendor-qrcode";
            }
            if (
              /\/node_modules\/(@radix-ui|cmdk|class-variance-authority|clsx|tailwind-merge)\//.test(
                normalized,
              )
            ) {
              return "vendor-ui";
            }
            return undefined;
          }
          if (normalized.endsWith("/src/i18n/en.ts")) {
            return "i18n-en";
          }
          if (normalized.includes("/packages/collab/")) {
            return "jiange-collab";
          }
          if (normalized.includes("/packages/render-gpu/")) {
            return "jiange-render-gpu";
          }
          return undefined;
        },
      },
    },
  },
  test: { setupFiles: ["./vitest.setup.ts"] },
  server: {
    port: 5173,
    proxy: {
      "/api/sync": { target: "ws://localhost:8080", ws: true },
      "/api/bases": { target: "ws://localhost:8080", ws: true },
      "/api/sheets": { target: "http://localhost:8080", ws: true },
      "/api/slides": { target: "http://localhost:8080", ws: true },
      "/api": "http://localhost:8080",
      "/scim": "http://localhost:8080",
      "/healthz": "http://localhost:8080",
    },
  },
} as Parameters<typeof defineConfig>[0]);