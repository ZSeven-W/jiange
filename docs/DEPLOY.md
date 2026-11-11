# 部署

## Docker Compose（一键）

```bash
docker compose up -d --build
```

打开 http://localhost:8080 注册即可。包含：

- `postgres` 16（数据卷 `pgdata`）
- `minio`（附件存储，控制台 :9001）
- `app` 单二进制（前端 embed 进 Go，自动跑迁移、自动建 bucket）

## 手动运行（开发）

```bash
pnpm install
docker compose up -d postgres minio
cd server && DATABASE_URL=postgres://jiange:jiange@localhost:5432/jiange?sslmode=disable \
  JIANGE_S3_ENDPOINT=http://localhost:9000 JIANGE_S3_ACCESS_KEY=jiange JIANGE_S3_SECRET_KEY=jiange-dev-secret \
  go run ./cmd/jiange     # :8080
pnpm --filter web dev     # :5173，/api 代理到 :8080
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `JIANGE_ADDR` | `:8080` | 监听地址 |
| `DATABASE_URL` | 见 compose | Postgres 连接串 |
| `JIANGE_SESSION_TTL` | `720h` | 会话时长 |
| `JIANGE_SECURE_COOKIES` | `false` | HTTPS 下置 true |
| `JIANGE_ALLOWED_ORIGINS` | `localhost:5173,…` | WebSocket 允许的来源 |
| `JIANGE_SECRET_KEY` | 空 | 加密用户在「AI 设置」中保存的 API Key（任意长随机字符串，部署后勿更换，否则已存 Key 需用户重新填写）；为空时不能保存 API Key，AI 功能不可用 |
| `JIANGE_S3_ENDPOINT` 等 | 空 | 不配则附件关闭 |
| `JIANGE_AUTO_VERSION_EVERY` | `30m` | 自动历史版本间隔，0 关闭 |

## 数据备份

Postgres 卷 `pgdata`（文档/多维表格/评论/通知）与 MinIO 卷 `miniodata`（附件）。
