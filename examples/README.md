# Jiange SDK Examples

Runnable, zero-boilerplate examples demonstrating the TypeScript Headless SDKs, the WebGPU/WebGL2 + Virtual List UI SDKs, and the Go Backend SDK:

- [`ui-playground/`](./ui-playground/README.md): Zero-bundler, native browser ESM (`<script type="importmap">`) interactive **WebGPU/WebGL2 + Virtual List UI Playground** showcasing `@jiange/render-gpu` (`GlyphAtlas`, SDF Rect/Line/Arc) and all 5 `@jiange/*-ui` packages directly from `packages/*/dist/`.
  ```bash
  pnpm -r build
  node examples/ui-playground/serve.mjs   # http://127.0.0.1:4173
  ```
- [`ts-headless/demo.mjs`](./ts-headless/demo.mjs): End-to-end AI Agent workflow across `@jiange/sheet-sdk`, `@jiange/doc-sdk`, `@jiange/slides-sdk`, `@jiange/whiteboard-sdk`, and `@jiange/base-sdk` in pure Node.js ESM.
  ```bash
  pnpm --filter @jiange/collab exec tsx ../../examples/ts-headless/demo.mjs
  ```
- [`go-backend/main.go`](./go-backend/main.go): Embedding `sdk/go/server` into an existing Go `net/http` host service with Bearer auth, formula evaluation, and AI/MCP endpoints.
  ```bash
  cd examples/go-backend && go run . --check
  ```
