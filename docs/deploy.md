# 部署指南

生产级 Kubernetes（Helm Chart / Kustomize）、Prometheus 监控与多副本水平扩展细节另见 [deploy/README.md](../deploy/README.md)。

## Docker Compose（一键启动）

```bash
docker compose up -d --build
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8080/readyz
```

打开 http://localhost:8080 注册即可。默认包含：

- `postgres` 16（数据卷 `pgdata`，自动运行 `0001..0092` 迁移）
- `minio`（对象存储，控制台 `:9001`，自动创建 bucket）
- `app` 单二进制（前端编译后通过 `embed.FS` 内嵌进 Go 静态二进制；当设置了 `JIANGE_S3_ENDPOINT` 时自动走 MinIO，未设置 S3 时回落到本地 `/data/blobs`）

## 手动运行（本地开发）

```bash
pnpm install
docker compose up -d postgres minio
cd server && DATABASE_URL=postgres://jiange:jiange@localhost:5432/jiange?sslmode=disable \
  JIANGE_S3_ENDPOINT=http://localhost:9000 JIANGE_S3_ACCESS_KEY=jiange JIANGE_S3_SECRET_KEY=jiange-dev-secret \
  go run ./cmd/jiange              # :8080
pnpm --filter @jiange/web dev      # :5173，代理 /api 与 /scim 到 :8080
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `JIANGE_ADDR` | `:8080` | HTTP/WebSocket 监听地址（容器内亦可由 `PORT` 映射） |
| `DATABASE_URL` | 见 compose | PostgreSQL 16+ 连接串（4 大协同 Hub 的多副本广播依赖 Postgres `LISTEN/NOTIFY`） |
| `JIANGE_SESSION_TTL` | `720h` | 会话有效期 |
| `JIANGE_SECURE_COOKIES` | `false` | HTTPS 生产环境置为 `true` |
| `JIANGE_ALLOWED_ORIGINS` | `localhost:5173,…` | 允许建立实时协同 WebSocket 的来源域名列表（逗号分隔） |
| `JIANGE_SECRET_KEY` | 空 | 32+ 字节随机密钥（AES-256-GCM 加密个人 AI API Key、SSO 客户端密钥、LDAP/企微/钉钉同步凭据、Webhook 与通知渠道密钥）；部署后切勿更换 |
| `JIANGE_S3_ENDPOINT` / `JIANGE_S3_BUCKET` / `JIANGE_S3_ACCESS_KEY` / `JIANGE_S3_SECRET_KEY` | 空 | S3/MinIO 附件存储配置（多副本推荐）；不配且未配 `JIANGE_BLOB_DIR` 时关闭上传 |
| `JIANGE_BLOB_DIR` | 空 | 单机本地磁盘附件目录；设置后优先于 S3 |
| `JIANGE_AUTO_VERSION_EVERY` | `30m` | 文档自动历史版本巡检间隔，`0` 关闭 |
| `JIANGE_ENABLE_CONDITIONAL_CANCEL` | `false` | 文档待确认操作安全停止开关（需确保所有写入节点已升级支持停止屏障后再开启） |
| `JIANGE_METRICS_TOKEN` | 空 | 可选 Bearer Token，用于保护 Prometheus `/metrics` 抓取接口 |
| `JIANGE_AI_EMBEDDING_MODEL` | 空 | 可选远端 `/embeddings` 模型名（未配置时自动使用内置 128 维本地向量 + BM25 混合检索） |
| `JIANGE_OCR_URL` / `JIANGE_OCR_MODE` / `JIANGE_OCR_API_KEY` / `JIANGE_OCR_MODEL` / `JIANGE_OCR_TIMEOUT_SECONDS` / `JIANGE_OCR_TESSERACT` | 空 | 可选图片与扫描版 PDF OCR 连接器（支持自定义 HTTP JSON、OpenAI Vision `mode=openai` 或本地 `tesseract`） |

## 备份、恢复与存量附件索引回填

```bash
cd server
go run ./cmd/jiange backup /path/to/jiange-backup.tar.gz          # SHA-256 校验全量导出 DB + Blobs
go run ./cmd/jiange restore /path/to/jiange-backup.tar.gz         # 先验签后单事务原子恢复
go run ./cmd/jiange reindex-attachments [workspaceId]             # 存量附件全文 / OCR 索引回填
```
