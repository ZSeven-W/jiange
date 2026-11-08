# Jiange

开源的飞书文档 + 多维表格替代品，AI 原生、可自部署。除基础库外全部自研：自研协同模型（CRDT）、自研 Go 同步与 API 服务。
An open-source, self-hostable, AI-native alternative to Feishu/Lark Docs and Base. Apart from a few foundational libraries, everything is written from scratch, including the collaborative data model (CRDT) and the Go backend.

> 状态 / Status: **P0 + P1 done**（脚手架、账号会话、协同内核）。编辑器、同步服务、文档树等在后续阶段实现。

## 目录 / Layout

```
apps/web          React + Vite + TS + TanStack Query + Tailwind + shadcn/ui
packages/collab   协同内核 (TS): OpId/Lamport, Fugue 文本序列, 块树 LWW+move, Peritext 标记, 二进制编码
server/           Go 模块: cmd/jiange, internal/{api,auth,httpx,migrate,store,config}, collab (Go 版内核)
spec/             PROTOCOL.md 协议规范 + vectors/ 跨语言一致性向量
docker-compose.yml  Postgres + MinIO
ci/               GitHub Actions workflow (see ci/README.md to enable)
```

## 允许的基础库 / Allowed foundational libraries

| 层 Layer | 依赖 Dependencies |
|---|---|
| Web | react, react-dom, @tanstack/react-query, tailwindcss, shadcn/ui（及其 @radix-ui/*, class-variance-authority, clsx, tailwind-merge） |
| Go | 标准库 stdlib, github.com/jackc/pgx/v5, github.com/coder/websocket |
| Dev | vite, typescript, vitest, tsx |

不使用 Yjs / Tiptap / ProseMirror / 任何 Web 框架或 ORM。No Yjs, Tiptap, ProseMirror, web frameworks or ORMs.

## 本地运行 / Run locally

Requirements: Node 20+, pnpm 10, Go 1.27+, Docker (for Postgres).

```bash
pnpm install
docker compose up -d postgres            # postgres://jiange:jiange@localhost:5432/jiange

cd server && go run ./cmd/jiange         # :8080, runs migrations on start
# 另开终端 / another terminal
pnpm --filter @jiange/web dev            # http://localhost:5173 (proxies /api -> :8080)
```

环境变量 / Env: `DATABASE_URL`, `JIANGE_ADDR` (default `:8080`), `JIANGE_SESSION_TTL` (default `720h`), `JIANGE_SECURE_COOKIES=true` behind HTTPS.

## 测试 / Tests

```bash
pnpm test                                # collab 内核 + web 单测 (vitest)
pnpm --filter @jiange/web build
cd server && go test ./...               # Go 单测 + 跨语言向量
JIANGE_TEST_DATABASE_URL=postgres://jiange:jiange@localhost:5432/jiange_test?sslmode=disable go test ./internal/store
go test ./collab -run '^$' -fuzz FuzzDecode -fuzztime 30s
pnpm gen:vectors                         # 修改内核后重新生成 spec/vectors
```

跨语言一致性：TS 生成 `spec/vectors/encoding.json`（ops ↔ 十六进制字节）和 `scenarios.json`（ops → 期望物化视图，含 5 个随机 3 副本会话）。Go 测试逐字节比对编码，并以 25 种随机乱序 + 重复投递重放每个场景，结果必须与 TS 完全一致。

## API (P0)

| Method | Path | 说明 |
|---|---|---|
| GET | /healthz | 健康检查 (DB ping) |
| POST | /api/auth/register | `{email,name,password}` → 创建用户与个人工作区，设置会话 Cookie |
| POST | /api/auth/login | `{email,password}` |
| POST | /api/auth/logout | 删除会话 |
| GET | /api/me | 当前用户与工作区 |

会话：32 字节随机 token，仅存 SHA-256 哈希；Cookie `HttpOnly; SameSite=Lax`。密码：PBKDF2-HMAC-SHA256（600k 次，Go 标准库 `crypto/pbkdf2`）。写请求必须为 `application/json`（配合 SameSite 防 CSRF）。

## 路线图 / Roadmap

P0 脚手架 ✅ · P1 协同内核 ✅ · P2 Go 同步服务 ✅ · P3 块编辑器 · P4 文档树与权限 · P5 多维表格 MVP · P6 版本、导入导出、发布

## License

个人与非商业使用免费；商业使用（含企业生产经营、托管/SaaS、集成进商业产品等）需购买商业授权，详见 [LICENSE](./LICENSE)。

## 设计 / Design
UI 先在 OpenPencil 中设计（`design/jiange.op`），预览见 `design/previews/`，
设计变量（`design/vars.json`）映射为 `apps/web/src/index.css` 中的 Tailwind/shadcn 主题变量。

### Attachments (MinIO / S3)

Set `JIANGE_S3_ENDPOINT` (e.g. `http://localhost:9000`), `JIANGE_S3_ACCESS_KEY`, `JIANGE_S3_SECRET_KEY` and optionally `JIANGE_S3_BUCKET` (default `jiange`; created on start). Without an endpoint, uploads are disabled. With docker-compose: `JIANGE_S3_ENDPOINT=http://localhost:9000 JIANGE_S3_ACCESS_KEY=jiange JIANGE_S3_SECRET_KEY=jiange-dev-secret`.

> 开发路线与交接说明见 [ROADMAP.md](ROADMAP.md)。
