# Jiange Playwright E2E Regression Suite

Automated end-to-end browser regression tests covering Jiange's full-stack authentication, multi-workspace lifecycle, core collaborative editors, enterprise governance, observability, i18n, and offline resilience.

## Test Coverage

| Spec | Flows Covered |
| --- | --- |
| `tests/auth-and-workspace.spec.ts` | Live UI registration into Workspace Home, multi-workspace create/switch/rename/delete, Account Security dialog (MFA, Passkeys, PAT create & revoke), zero native `<select>`, zero console errors |
| `tests/suite-editors.spec.ts` | Document title + collaborative body persistence across reload, Spreadsheet cell values + formula (`=A1+A2`) persistence, Base grid + persistent record creation, Slides canvas rendering + save, Global Search lookup |
| `tests/enterprise-admin.spec.ts` | `/healthz`, `/readyz`, `/metrics`, `/api/openapi.json` (350+ operations), `/scim/v2/{ServiceProviderConfig,Schemas,ResourceTypes}`, Org Security & Audit DLP + Require MFA persistence & reset, SSO OIDC & SAML 2.0 modal, Developer OpenAPI 3.1 explorer & SCIM 2.0 reference table |
| `tests/offline-and-i18n.spec.ts` | Chinese ↔ English locale toggle across sidebar and Organization tabs, browser offline mode banner & cache drawer resilience, online recovery |

Every spec registers a fresh timestamped user so tests are isolated and idempotent against any PostgreSQL database.

## Prerequisites

Install workspace dependencies and Playwright's Chromium binary once:

```bash
pnpm install
pnpm exec playwright install chromium
```

> **macOS shortcut:** If Google Chrome is already installed locally, you can skip downloading Chromium and pass `E2E_BROWSER_CHANNEL=chrome`.

## Running Locally

### Option A: Against Vite Dev Server (`:5173`) + Go API Server (`:8080`)

Ensure PostgreSQL, the Go server (`:8080`), and Vite (`:5173`) are running, then run:

```bash
pnpm test:e2e
```

If Vite binds to `localhost` (`::1`) rather than `127.0.0.1`, specify `E2E_BASE_URL`:

```bash
E2E_BASE_URL=http://localhost:5173 E2E_API_URL=http://127.0.0.1:8080 pnpm test:e2e
```

### Option B: Against Single Embedded Go Binary (`:8080`)

```bash
pnpm --filter @jiange/web... build
rm -rf server/webui/dist && mkdir -p server/webui/dist && cp -R apps/web/dist/. server/webui/dist/
(cd server && go build -o ../jiange ./cmd/jiange)
DATABASE_URL="postgres://jiange:jiange@127.0.0.1:5432/jiange?sslmode=disable" \
  JIANGE_ADDR="127.0.0.1:8080" \
  JIANGE_SECURE_COOKIES="false" \
  ./jiange &

E2E_BASE_URL=http://127.0.0.1:8080 E2E_API_URL=http://127.0.0.1:8080 pnpm test:e2e
```

### Useful Playwright Commands

```bash
# List all discovered tests without launching a browser
pnpm exec playwright test -c e2e/playwright.config.ts --list

# Run a single spec file
pnpm exec playwright test -c e2e/playwright.config.ts e2e/tests/auth-and-workspace.spec.ts

# Run headed with local Chrome
E2E_BROWSER_CHANNEL=chrome E2E_BASE_URL=http://localhost:5173 pnpm exec playwright test -c e2e/playwright.config.ts --headed

# Open the HTML report after a run
pnpm exec playwright show-report playwright-report
```

## Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `E2E_BASE_URL` | `http://127.0.0.1:5173` | Web SPA origin loaded by Playwright |
| `E2E_API_URL` | `http://127.0.0.1:8080` | Direct Go server origin for `/healthz`, `/readyz`, `/metrics`, `/api/openapi.json`, `/scim/v2/*` |
| `E2E_BROWSER_CHANNEL` | *(unset -> bundled Chromium)* | Optional browser channel (e.g. `chrome`) |

## CI Integration

The `e2e` job in `.github/workflows/ci.yml` starts a `postgres:16` service container, builds `@jiange/web`, embeds `apps/web/dist` into `server/webui/dist`, compiles and starts `./jiange` on `127.0.0.1:8080`, waits for `/readyz`, installs Playwright Chromium (`--with-deps`), runs `pnpm test:e2e`, and uploads `playwright-report`, `test-results`, and server logs on failure.
