# Jiange SDK Examples

Runnable, zero-boilerplate examples demonstrating both the TypeScript AI-Native SDKs and the Go Backend SDK:

- [`ts-headless/demo.mjs`](./ts-headless/demo.mjs): End-to-end AI Agent workflow across `@jiange/sheet-sdk`, `@jiange/doc-sdk`, `@jiange/slides-sdk`, `@jiange/whiteboard-sdk`, and `@jiange/base-sdk` in pure Node.js ESM.
  ```bash
  pnpm --filter @jiange/collab exec tsx ../../examples/ts-headless/demo.mjs
  ```
- [`go-backend/main.go`](./go-backend/main.go): Embedding `sdk/go/server` into an existing Go `net/http` host service with Bearer auth, formula evaluation, and AI/MCP endpoints.
  ```bash
  cd examples/go-backend && go run . --check
  ```
