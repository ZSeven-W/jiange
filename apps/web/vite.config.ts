/// <reference types="vitest" />
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { setupFiles: ["./vitest.setup.ts"] },
  server: {
    port: 5173,
    proxy: {
      "/api/sync": { target: "ws://localhost:8080", ws: true },
      "/api/bases": { target: "ws://localhost:8080", ws: true },
      "/api": "http://localhost:8080",
      "/healthz": "http://localhost:8080",
    },
  },
} as Parameters<typeof defineConfig>[0]);