# Contributing to Jiange / 贡献指南

感谢关注 **Jiange**！欢迎通过 Issue、Discussion 或 Pull Request 参与改进。

## Local Development / 本地开发

Prerequisites: **Node 20+**, **pnpm 10+**, **Go 1.23+** (matching `server/go.mod`), and **Docker** (for PostgreSQL 16).

```bash
pnpm install
docker compose up -d postgres

# Terminal 1: Go backend (:8080, runs DB migrations automatically)
cd server && go run ./cmd/jiange

# Terminal 2: Web frontend (:5173, proxies /api & /scim -> :8080)
pnpm --filter @jiange/web dev
```

## Repo Conventions / 仓库规范

1. **File Naming (`kebab-case`)**: All project files and directories use `kebab-case` (enforced in CI via `pnpm lint:names`). Standard root docs (`README*.md`, `CHANGELOG.md`, `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`) and `.github/ISSUE_TEMPLATE` follow GitHub conventions.
2. **Zero External Dependencies in SDKs & CLI**:
   - `packages/*` must remain **zero runtime dependencies** (pure ES2022 TypeScript + WebGPU/WebGL2).
   - `sdk/go`, `sdk/go-pgstore`, and `cli` must remain **pure Go stdlib** with zero third-party runtime dependencies.
3. **Bilingual i18n**: User-facing strings in `apps/web` support Chinese & English without missing translation keys.

## Quality Gates / 提交前检查

Run relevant gates before opening a PR:

```bash
pnpm lint:names
pnpm -r build && pnpm -r typecheck
pnpm test
pnpm test:sdk:coverage
cd cli && go test -race -cover ./...
cd ../sdk/go && go test -race -cover ./...
cd ../../server && go test ./... && go vet ./...
```

If you modify the CRDT collab engine (`packages/collab`), regenerate cross-language test vectors:

```bash
pnpm gen:vectors
```
