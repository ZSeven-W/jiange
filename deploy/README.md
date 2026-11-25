# Deploying Jiange

This directory contains production Kubernetes manifests (Helm chart and Kustomize base) alongside operational guides for observability and disaster-recovery backups.

## Prerequisites

- **PostgreSQL 16+** (required; multi-replica realtime fan-out uses Postgres `LISTEN`/`NOTIFY`).
- **S3-compatible object storage** such as MinIO or AWS S3 for multi-replica attachment storage (single-node deployments may use `JIANGE_BLOB_DIR`).
- **`JIANGE_SECRET_KEY`** (32+ random bytes) to encrypt saved AI API keys, SSO client secrets, and webhook signing secrets.

---

## 1. Docker Compose (Local / Single-Host)

The repository root includes [`docker-compose.yml`](../docker-compose.yml) with PostgreSQL 16, MinIO, and the all-in-one Jiange binary:

```bash
docker compose up -d --build
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8080/readyz
```

---

## 2. Helm Chart (`deploy/helm/jiange`)

### Create a Kubernetes Secret (Recommended)

Avoid committing plaintext credentials in `values.yaml`. Pre-create a Secret (or manage it via ExternalSecrets / SealedSecrets):

```bash
kubectl create namespace jiange
kubectl -n jiange create secret generic jiange-secrets \
  --from-literal=database-url='postgres://jiange:<password>@postgres.db.svc:5432/jiange?sslmode=require' \
  --from-literal=secret-key="$(openssl rand -hex 32)" \
  --from-literal=s3-access-key='<access-key>' \
  --from-literal=s3-secret-key='<secret-key>' \
  --from-literal=metrics-token="$(openssl rand -hex 24)"
```

### Install & Upgrade

```bash
helm upgrade --install jiange ./deploy/helm/jiange \
  --namespace jiange --create-namespace \
  --set image.tag=1.0.0 \
  --set secrets.existingSecret=jiange-secrets \
  --set config.allowedOrigins=jiange.example.com \
  --set config.s3.endpoint=http://minio.storage.svc:9000 \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=jiange.example.com \
  --set metrics.serviceMonitor.enabled=true \
  --set metrics.serviceMonitor.useMetricsToken=true
```

### Validate Locally Before Deploying

```bash
helm lint ./deploy/helm/jiange
helm template jiange ./deploy/helm/jiange --set ingress.enabled=true --set metrics.serviceMonitor.enabled=true
```

---

## 3. Raw Kustomize (`deploy/k8s`)

1. Create the namespace and `jiange-secrets` Secret:

```bash
kubectl apply -f deploy/k8s/namespace.yaml
kubectl -n jiange create secret generic jiange-secrets \
  --from-literal=database-url='postgres://jiange:<password>@postgres:5432/jiange?sslmode=require' \
  --from-literal=secret-key="$(openssl rand -hex 32)" \
  --from-literal=s3-access-key='<access-key>' \
  --from-literal=s3-secret-key='<secret-key>'
```

2. Customize `deploy/k8s/kustomization.yaml` (or create a Kustomize overlay for your domain, image tag, and S3 endpoint) and apply:

```bash
kubectl apply -k deploy/k8s
kubectl -n jiange rollout status deployment/jiange
```

---

## 4. Observability & Prometheus Scraping

Jiange exposes three built-in operational endpoints and W3C distributed tracing headers:

| Endpoint | Probe / Role | Notes |
| --- | --- | --- |
| `GET /healthz` | Liveness / Startup | Verifies process + DB ping (`200` / `503`). |
| `GET /readyz` | Readiness | Returns JSON `{status, checks: {database, blobs}, uptimeSeconds}` (`200` ready / `503` degraded). |
| `GET /metrics` | Prometheus 0.0.4 | Exposes runtime, WS room gauges (`doc`, `base`, `sheet`, `slides`), Postgres pool stats, and HTTP request counters/latency histograms. |

- **Protecting `/metrics`**: Set `JIANGE_METRICS_TOKEN`. Requests must then send `Authorization: Bearer <token>`. When using `kube-prometheus-stack`, enable `metrics.serviceMonitor.enabled=true` and `metrics.serviceMonitor.useMetricsToken=true` so Prometheus attaches the Secret token automatically.
- **Distributed Tracing**: Every response includes a W3C `Traceparent` header (`00-<trace-id>-<span-id>-<flags>`). Incoming valid `traceparent` headers preserve the upstream `trace-id` and `flags` while minting a new server `span-id`.

---

## 5. Backup & Restore CLI

Jiange exports portable, SHA-256 verified `.tar.gz` archives containing `manifest.json`, `tables/<name>.jsonl` (all public Postgres tables except `schema_migrations`), and `blobs/<key>` (local attachment blobs).

### Create a Backup

```bash
DATABASE_URL="postgres://jiange:...@postgres:5432/jiange?sslmode=require" \
JIANGE_BLOB_DIR="/data/blobs" \
  jiange backup ./jiange-backup-$(date -u +%Y%m%dT%H%M%SZ).tar.gz
```

From a Kubernetes pod:

```bash
POD=$(kubectl -n jiange get pod -l app.kubernetes.io/name=jiange -o jsonpath='{.items[0].metadata.name}')
kubectl -n jiange exec "$POD" -- /usr/local/bin/jiange backup /tmp/jiange-backup.tar.gz
kubectl -n jiange cp "jiange/$POD:/tmp/jiange-backup.tar.gz" ./jiange-backup.tar.gz
kubectl -n jiange exec "$POD" -- rm -f /tmp/jiange-backup.tar.gz
```

### Restore a Backup

`jiange restore` validates `manifest.json` and every member's SHA-256 checksum **before** writing any blobs or opening a database transaction. Database tables are truncated and reloaded atomically in a single transaction, and Postgres sequences are reset automatically:

```bash
DATABASE_URL="postgres://jiange:...@postgres:5432/jiange?sslmode=require" \
JIANGE_BLOB_DIR="/data/blobs" \
  jiange restore ./jiange-backup.tar.gz
```

> **Tip:** Scale replicas down to `0` (or pause writes) before running `jiange restore` against a live production database to avoid concurrent write conflicts.

---

## 6. Attachment Full-Text & OCR Index Backfill

Existing attachments uploaded prior to enabling full-text indexing or OCR can be backfilled from the CLI (for all workspaces or a single workspace ID):

```bash
DATABASE_URL="postgres://jiange:...@postgres:5432/jiange?sslmode=require" \
JIANGE_S3_ENDPOINT="http://minio.storage.svc:9000" \
JIANGE_S3_ACCESS_KEY="<access-key>" \
JIANGE_S3_SECRET_KEY="<secret-key>" \
  jiange reindex-attachments            # optional: pass <workspaceId>
```

To enable OCR for images and image-only scanned PDFs, configure `config.ocr.*` (`JIANGE_OCR_URL`, `JIANGE_OCR_MODE=openai` or default JSON, `JIANGE_OCR_MODEL`, `JIANGE_OCR_TIMEOUT_SECONDS`, or `JIANGE_OCR_TESSERACT=1`) and secret key `ocr-api-key` (`JIANGE_OCR_API_KEY`). Workspace admins can also trigger workspace-scoped reindexing directly from **Organization -> Security & Audit -> Storage & Attachment Index**.
