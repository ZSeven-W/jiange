# Jiange

<p align="center">
  <img src="apps/web/public/brand/jiange-lockup.svg" width="240" alt="Jiange" />
</p>

<p align="center">
  <a href="README.md">简体中文</a> ·
  <a href="README.en.md">English</a> ·
  <a href="README.zh-TW.md">繁體中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.es.md">Español</a> ·
  <b>Русский</b>
</p>

<p align="center">
  <a href="https://github.com/ZSeven-W/jiange/actions/workflows/ci.yml"><img src="https://github.com/ZSeven-W/jiange/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/ZSeven-W/jiange/releases/latest"><img src="https://img.shields.io/github/v/release/ZSeven-W/jiange?label=release&color=3370FF" alt="Latest Release" /></a>
  <a href="https://www.npmjs.com/package/@zseven-w/sheet-sdk"><img src="https://img.shields.io/npm/v/%40zseven-w%2Fsheet-sdk?label=npm%20%40zseven-w%2F*&color=CB3837" alt="npm SDKs" /></a>
  <a href="https://github.com/ZSeven-W/jiange/pkgs/container/jiange"><img src="https://img.shields.io/badge/ghcr.io-zseven--w%2Fjiange-2496ED?logo=docker&logoColor=white" alt="GHCR Docker Image" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Dual--Track%20%7C%20SDK%20Free-10B981" alt="License" /></a>
</p>

<p align="center">
  <strong>Полнофункциональный пакет совместной работы с открытым исходным кодом: документы, электронные таблицы, многомерные базы, презентации и доски/интеллект-карты в стиле Feishu/Lark</strong><br />
  <sub>AI-native · Модульная и лёгкая архитектура · Корпоративная безопасность и комплаенс · Горизонтальная масштабируемость · Двуязычный интерфейс и офлайн-CRDT · Без Canvas 2D (WebGPU/WebGL2 + виртуализация)</sub>
</p>

<p align="center">
  Альтернатива Feishu/Lark Docs, Sheets, Base, Slides и Whiteboard/MindMap с открытым исходным кодом и возможностью самостоятельного развёртывания: собственный движок CRDT, бэкенд на чистой стандартной библиотеке Go (SAML 2.0, OIDC, SCIM 2.0, LDAP/WeCom/DingTalk, WebAuthn Passkeys, DLP, Prometheus, OpenAPI 3.1), 13 TypeScript/WebGPU SDK без сторонних зависимостей, а также единый бинарный Go CLI и MCP-сервер.
</p>

---

## Промо-видео

<p align="center">
  <a href="design/promo/jiange-promo.mp4">
    <img src="design/promo/jiange-promo-cover.png" alt="Промо-видео Jiange — нажмите для просмотра" width="100%" />
  </a>
</p>

<p align="center">
  <sub>
    ▶ <a href="design/promo/jiange-promo.mp4"><b>Смотреть полное промо-видео (MP4 · 30 сек · с оригинальным саундтреком)</b></a><br />
    Анимация создана и экспортирована из нативного проекта <code>.op</code> в <b>OpenPencil v0.8.6</b> (<a href="design/promo/jiange-promo.op"><code>design/promo/jiange-promo.op</code></a> / <a href="design/promo/build-jiange-promo.py">скрипт сборки</a>), музыка сгенерирована локальной инструментальной моделью <b>MiniMax H3-Music</b>.
  </sub>
</p>

---

## Ключевые возможности пакета

| Модуль | Возможности |
|---|---|
| **Облачные документы (Cloud Doc)** | Совместное редактирование в реальном времени на собственном CRDT RGA/Fugue, **полноценное офлайн-редактирование с автоматическим слиянием при переподключении** (хранение реплик в IndexedDB), 15+ типов блоков (включая нативные `audio` / `video` / интерактивные опросы `poll` / таймер `countdown` / вкладки `tabs` / таблицы / код / формулы / Mermaid / синхронизируемые блоки / многоколоночную вёрстку / встроенные таблицы), **режим исправлений (Track Changes)**, комментарии к выделенному тексту и реакции эмодзи, совместное чтение (Follow), история версий, импорт/экспорт DOCX и Markdown (с изображениями) и печать в PDF |
| **Электронные таблицы (Sheet)** | Виртуальная сетка на WebGPU/WebGL2 на миллионы строк, **148 встроенных формульных функций** (включая `XLOOKUP` / `FILTER` / `SORT` / `UNIQUE` / `LET` / `LAMBDA` / `ARRAYFORMULA` / `QUERY` / `REGEX*` / `IMAGE`), плавающие диаграммы, сводные таблицы, **встроенные SVG-спарклайны (Sparklines)**, сворачиваемые группы строк и столбцов, изображения в ячейках, условное форматирование / проверка данных / защищённые диапазоны, облачные именованные диапазоны, история версий и журнал изменений ячеек, офлайн-слияние дельт ячеек, импорт/экспорт XLSX и CSV, **AI-ассистент формул** |
| **Многомерные базы (Base)** | Многотабличные базы и двусторонние связи между таблицами, **23 типа полей** (включая валюту, прогресс, автонумерацию, кнопки действий, геолокацию, формулы, связи, подстановки/Lookup), **7 представлений** (сетка, канбан, диаграмма Ганта с зависимостями, календарь, галерея, **иерархическое дерево**, публичные формы с условным ветвлением), до 3 уровней вложенной группировки, многошаговая автоматизация, дашборды, ролевой доступ RBAC на уровне строк и столбцов, импорт/экспорт XLSX и CSV, **массовое AI-заполнение столбцов** |
| **Презентации (Slides)** | Холст на WebGPU/WebGL2, **мастер-слайды и бренд-кит (Master Brand Kit)**, текстовые/геометрические/табличные/графические/видео-/аудиообъекты, обрезка изображений, пошаговая анимация элементов и переходы между слайдами, режим докладчика (лазерная указка / аннотации пером + **синхронный просмотр аудиторией через WebSocket**), комментарии к слайдам и объектам, история версий, офлайн-слияние черновиков слайдов, импорт/экспорт PPTX и печать в PDF |
| **Доски и интеллект-карты (Board & MindMap)** | Бесконечный холст, блок-схемы и дорожки (swimlanes), инструменты мозгового штурма (стикеры, маркер, точечное голосование, таймер, миникарта, фреймы группировки), многоструктурные интеллект-карты, границы / сводки / бейджи, двусторонняя синхронизация со структурой, экспорт в Mermaid / XMind / SVG / PNG |
| **База знаний, Диск и полнотекстовый поиск (Wiki & Drive)** | **Полный жизненный цикл мульти-пространств** (создание, переключение в один клик, переименование, передача прав владельца в UI/API, выход, удаление), отдельные пространства Wiki с многоуровневым деревом, ярлыки, **межпространственное перемещение (личные / общие / между рабочими пространствами)**, **панель использования хранилища и квотирование (HTTP 413)**, **онлайн-предпросмотр всех форматов** (масштабирование и поворот изображений, PDF, аудио/видео, код/Markdown/CSV, `.docx`/`.xlsx`/`.pptx`, включая богатый предпросмотр вложений в публичных документах), **извлечение текста вложений на чистом Go + подключаемый OCR (HTTP / OpenAI Vision / `tesseract`) + переиндексация существующих вложений из UI и CLI** |
| **AI-рабочее пространство (Workspace AI)** | **Гибридный семантический векторный + BM25 RAG по всей базе знаний** (локальные 128-мерные векторы + опциональный удалённый `/embeddings` + строгая изоляция прав + ссылки на источники из документов и PDF/Office/OCR-вложений), **двухканальный потоковый вывод SSE по токенам** (`POST /api/ai/workspace-ask/stream` · `POST /api/ai/doc/stream`), AI-генерация формул для таблиц, AI-заполнение баз, поддержка OpenAI / Anthropic-совместимых провайдеров (с автоматическим откатом на локальный движок без ключа) |
| **Корпоративный IAM и синхронизация каталогов (Enterprise IAM)** | **OIDC / OAuth2 + SAML 2.0 SP** (Metadata XML, AuthnRequest, нативная проверка подписи XML-DSig RSA/ECDSA и защита от XXE/XSW), **полный SCIM 2.0 (RFC 7644)** (`ServiceProviderConfig`, `Schemas`, `ResourceTypes`, полный `PUT`/`PATCH`/`DELETE`/фильтрация/пагинация для `Users` и `Groups`), **активный pull и плановая синхронизация LDAP v3 / WeCom / DingTalk** (нативный клиент ASN.1 BER + зашифрованные учётные данные), **TOTP MFA + 8 кодов восстановления + политика обязательного MFA на уровне пространства и глобальный баннер**, **беспарольный вход WebAuthn / Passkeys (FIDO2 ES256/RS256)**, **самообслуживание безопасности аккаунта** (ограничение частоты запросов от перебора на логин/MFA/Passkey/пароли публичных ссылок, смена пароля, сброс пароля через SMTP, список активных сессий и удалённый выход) |
| **Безопасность, комплаенс и открытая платформа (Governance & Open)** | **Корпоративный DLP по ключевым словам и безопасным регулярным выражениям RE2** (покрывает Doc / Sheet / Base / Slides / Survey, блокировка/предупреждения при публичном доступе и экспорте CSV/вложений), **политики хранения данных с фоновой и ручной очисткой**, водяные знаки во всём пакете, пароли для публичных ссылок, аудит-логи и экспорт в CSV, **полный контракт OpenAPI 3.1.0 (361 эндпоинт со 100% проверкой соответствия маршрутам + 27 схем + интерактивный портал разработчика)**, **персональные токены доступа (PAT)**, **HMAC-SHA256 вебхуки для всех 6 категорий событий пространства**, **внешние каналы уведомлений** (SMTP / Feishu / DingTalk / WeCom / Slack) |
| **Масштабирование, интернационализация и Cloud-Native (Scale & Ops)** | **Горизонтальное масштабирование всех 4 хабов реального времени** (Doc `syncsrv` / Base `btsync` / Sheet `sheetsync` / Slides `slidessync` с межузловой рассылкой через Postgres `LISTEN/NOTIFY`), **полная двуязычная интернационализация ZH/EN** (5 355 ключей, 0 непереведённых элементов UI), **разделение кода на уровне маршрутов `React.lazy` + Rollup** (основной чанк 308 KB / gzip 84 KB), PWA + IndexedDB офлайн-редактирование и автослияние (Doc / Base / Sheet / Slides), `/healthz` + `/readyz` + Prometheus `/metrics` + W3C `traceparent`, CLI-бэкап и восстановление с проверкой SHA-256 (`jiange backup` / `restore` / `reindex-attachments`), готовые к продакшену **Helm Chart** и манифесты **Kustomize** |

### Скриншоты интерфейса

<table>
  <tr>
    <td align="center" width="50%">
      <img src="design/screenshots/cloud-doc.png" alt="Облачные документы" width="100%" /><br />
      <b>Облачные документы (Cloud Doc)</b><br />
      <sub>Собственный CRDT для онлайн/офлайн-синхронизации, оглавление и блоки</sub>
    </td>
    <td align="center" width="50%">
      <img src="design/screenshots/sheet.png" alt="Электронные таблицы" width="100%" /><br />
      <b>Электронные таблицы (Sheet)</b><br />
      <sub>Виртуальная сетка на WebGPU, 148 формул, спарклайны и плавающие диаграммы</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="design/screenshots/base.png" alt="Многомерные базы" width="100%" /><br />
      <b>Многомерные базы (Base)</b><br />
      <sub>23 типа полей, сетка/канбан/Гант/дерево и массовое AI-заполнение</sub>
    </td>
    <td align="center" width="50%">
      <img src="design/screenshots/slides.png" alt="Презентации" width="100%" /><br />
      <b>Презентации (Slides)</b><br />
      <sub>Холст WebGPU, векторные диаграммы и таблицы, мастер-слайды и PPTX</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="design/screenshots/board.png" alt="Доски и интеллект-карты" width="100%" /><br />
      <b>Доски и интеллект-карты (Board &amp; MindMap)</b><br />
      <sub>Бесконечный холст, блок-схемы со свими, интеллект-карты и миникарта</sub>
    </td>
    <td align="center" width="50%">
      <img src="design/screenshots/workspace-ai.png" alt="Workspace AI" width="100%" /><br />
      <b>AI-рабочее пространство (Workspace AI)</b><br />
      <sub>Гибридный векторный + BM25 RAG-поиск со ссылками на первоисточники</sub>
    </td>
  </tr>
</table>

---

## Быстрый старт

Вы можете подключить Jiange четырьмя способами в зависимости от задач: как **полный пакет для самостоятельного развёртывания**, **npm TypeScript/WebGPU SDK**, **встраиваемый Go бэкенд-SDK** или **Go CLI / AI MCP-сервер**:

### 1. Запуск полного пакета совместной работы одной командой (Docker)

```bash
# Вариант A: запуск одной командой через Docker Compose (Postgres 16 + MinIO + полный пакет Jiange)
git clone https://github.com/ZSeven-W/jiange.git && cd jiange
docker compose up -d --build
# Откройте http://localhost:8080 и зарегистрируйте первого администратора рабочего пространства

# Вариант B: загрузить готовый мультиархитектурный образ напрямую из GHCR (linux/amd64 и linux/arm64)
docker pull ghcr.io/zseven-w/jiange:latest
docker run -d --name jiange -p 8080:8080 \
  -e DATABASE_URL="postgres://jiange:jiange@host.docker.internal:5432/jiange?sslmode=disable" \
  -e JIANGE_SECURE_COOKIES="false" \
  -e JIANGE_SECRET_KEY="$(openssl rand -hex 32)" \
  -v jiange_blobs:/data/blobs \
  ghcr.io/zseven-w/jiange:latest
```

> Для развёртывания в продакшен-кластере Kubernetes используйте Helm Chart (`helm upgrade --install jiange ./deploy/helm/jiange`); подробности см. в [deploy/README.md](deploy/README.md).

### 2. Использование TypeScript / WebGPU SDK (npm `@zseven-w/*`)

Все **13 пакетов без сторонних зависимостей** опубликованы на npmjs.com (`0.2.0`) и поддерживают независимую установку по модулям:

```bash
# Установка Headless-движков по необходимости (работают в Node.js / браузере / Edge / AI-агентах)
npm install @zseven-w/sheet-sdk        # Электронные таблицы (148 формул + XLSX/CSV + AI-инструменты)
npm install @zseven-w/doc-sdk          # Облачные документы (CRDT + MD/HTML/DOCX + комментарии и исправления)
npm install @zseven-w/base-sdk         # Многомерные базы (23 поля + 7 представлений + формулы и связи)
npm install @zseven-w/slides-sdk       # Презентации (PPTX + чистый TS 16:9 SVG)
npm install @zseven-w/whiteboard-sdk   # Доски и интеллект-карты (Mermaid + DAG-раскладка + XMind)

# Опционально: установка UI-компонентов WebGPU/WebGL2 + виртуального списка (без Canvas 2D, включая нативный mount / React / Web Components)
npm install @zseven-w/sheet-ui @zseven-w/doc-ui @zseven-w/base-ui @zseven-w/slides-ui @zseven-w/whiteboard-ui
```

Пример Headless-расчёта формул + пробного прогона AI-инструментов (`dryRun`) + экспорта в `.xlsx`:

```ts
import { Workbook, createSheetTools } from "@zseven-w/sheet-sdk";

const wb = Workbook.fromCsv("Product,Units,UnitPrice\nPro,120,49\nEnterprise,25,299\n", "Q4");
const tools = createSheetTools(wb);

// AI-агент сначала проверяет изменения через dryRun перед применением, формулы пересчитываются инкрементально
tools.execute("sheet_apply", {
  ops: [
    {
      op: "setCells",
      sheet: "Q4",
      cells: [
        { a1: "D1", raw: "Revenue" },
        { a1: "D2", raw: "=B2*C2" },
        { a1: "D3", raw: "=B3*C3" },
        { a1: "D4", raw: "=SUM(D2:D3)" },
      ],
    },
  ],
});

console.log(wb.sheet("Q4").getValue("D4")); // 13355
const xlsxBytes = await wb.toXlsxAsync();   // Стандартный поток байтов .xlsx со сжатием DEFLATE
```

Монтирование виртуальной сетки WebGPU/WebGL2 в браузере (поддерживаются нативный DOM / React / `<jiange-sheet>`):

```ts
import { mountSheetView } from "@zseven-w/sheet-ui";

const view = await mountSheetView(document.getElementById("sheet-root")!, wb);
// Вызовите view.dispose() при размонтировании
```

### 3. Встраивание бэкенд-SDK в Go-сервис (`sdk/go` и `sdk/go-pgstore`)

```bash
go get github.com/ZSeven-W/jiange/sdk/go@v0.2.0
go get github.com/ZSeven-W/jiange/sdk/go-pgstore@v0.2.0   # Опциональный адаптер хранения для PostgreSQL
```

```go
package main

import (
	"net/http"

	"github.com/ZSeven-W/jiange/sdk/go/server"
	"github.com/ZSeven-W/jiange/sdk/go/storage"
)

func main() {
	app := server.New(server.Config{
		Store:   storage.NewMemoryStore(), // В продакшене замените на pgstore.New(db)
		Auth:    storage.NewBearerTokenAuth(map[string]storage.Principal{"my-token": {ID: "u-1", Name: "Admin", Roles: []string{"admin"}}}),
		Version: "0.2.0",
	})
	mux := http.NewServeMux()
	mux.Handle("/api/v1/", http.StripPrefix("/api/v1", app))
	_ = http.ListenAndServe(":8090", mux)
}
```

### 4. Использование Go CLI и MCP-сервера для AI-агентов (`jiange`)

```bash
# Установка через Go Module (или скачайте готовые статические бинарники для 5 платформ на GitHub Releases)
go install github.com/ZSeven-W/jiange/cli/cmd/jiange@v0.2.0

# Прямое чтение и редактирование офисных файлов локально (без зависимости от Node.js)
jiange sheet inspect budget.xlsx --detail full
jiange sheet patch budget.xlsx --ops '[{"op":"setCell","sheet":"Sheet1","a1":"B2","raw":"=SUM(A1:A10)"}]' --out out.xlsx
jiange doc convert spec.md --out spec.docx
jiange slides render deck.pptx --slide 0 --out slide1.svg
jiange board render arch.mmd --out arch.svg

# Запуск MCP-сервера (поддерживает stdio или Streamable HTTP)
jiange mcp --transport stdio
jiange mcp --transport http --addr 127.0.0.1:8787
```

Настройте напрямую в MCP-клиентах, таких как **Claude Desktop / Cursor / Antigravity**:

```json
{
  "mcpServers": {
    "jiange": {
      "command": "jiange",
      "args": ["mcp", "--transport", "stdio"]
    }
  }
}
```

> Готовые бинарники CLI (Linux / macOS / Windows `amd64` и `arm64`) и все офлайн-архивы SDK доступны в [GitHub Releases (`sdk-v0.2.0`)](https://github.com/ZSeven-W/jiange/releases/tag/sdk-v0.2.0), а полный справочник API — в [sdk-docs/getting-started.md](sdk-docs/getting-started.md).

---

## Структура репозитория

```text
apps/web              Веб-клиент Jiange (React + Vite + TS + TanStack Query + Tailwind + shadcn/ui)
server/               Go-сервер Jiange: cmd/jiange, internal/{api,auth,backup,blob,btformula,btquery,btsync,config,httpx,migrate,sheetstore,sheetsync,slidessync,store,syncsrv,tableadmission}, collab
packages/
  ooxml               L0: Синхронный STORE + асинхронный DEFLATE ZIP и безопасный ограниченный XML без зависимостей
  collab              L0: Ядро совместной работы (RGA/Fugue CRDT, офлайн-гидратация и автослияние, Undo, ./table, ./ws, ./storage, ./ai-agent)
  sheet-sdk           L1: Headless AI-Native SDK таблиц (инкрементальный AST+DAG движок, 148 функций, XLSX/CSV, Worker)
  doc-sdk             L1: Headless AI-Native SDK документов (Document Facade, MD/HTML/DOCX, комментарии и исправления)
  slides-sdk          L1: Headless AI-Native SDK презентаций (Presentation, PPTX, чистый TS 16:9 SVG, медиа и обрезка)
  whiteboard-sdk      L1: Headless AI-Native SDK досок/интеллект-карт (Board, двусторонний Mermaid, DAG-раскладка, XMind, SVG)
  base-sdk            L1: Headless AI-Native SDK многомерных баз без зависимостей (23 поля, 7 представлений, формулы, связи, дашборды, CSV)
  render-gpu          L2: Ядро рендеринга без Canvas 2D (WebGPU/WebGL2 SDF+GlyphAtlas, Fenwick-виртуализация на 1M строк, SpatialIndex)
  {sheet,doc,slides,whiteboard,base}-ui
                      L2: 5 независимых лёгких UI SDK (нативный mount, ./react, веб-компоненты <jiange-*>)
cli/                  Нативный Go 1.23 CLI и Streamable HTTP/stdio MCP-сервер без внешних зависимостей (один бинарник ~5.5 MB)
sdk/go/               Встраиваемый Go 1.23 бэкенд-SDK без внешних зависимостей (10 пакетов: storage, sync, 5 доменных движков, ai, server, client)
sdk/go-pgstore/       Опциональный PostgreSQL-адаптер storage.Store (стандартный database/sql, совместим с pgx/v5/stdlib и lib/pq)
sdk-docs/             Полные руководства по SDK, справочник API, протокол AI-Native, WebGPU UI и интеграция с Go
deploy/               Kubernetes Helm Chart (deploy/helm/jiange), манифесты Kustomize (deploy/k8s) и руководство по эксплуатации
e2e/                  Набор браузерных E2E-тестов Playwright (интегрирован с job `e2e` в GitHub Actions CI)
benchmarks/           Автоматические шлюзы RFC §7: SLA производительности, размер бандла, отсутствие Canvas 2D и изолированная установка 13 пакетов
examples/             Рабочие примеры: ts-headless, go-backend и zero-build WebGPU/WebGL2 ui-playground
design/               Исходники дизайна OpenPencil (jiange.op) и проект промо-ролика (promo/jiange-promo.op + mp4)
spec/                 Спецификация протокола совместной работы PROTOCOL.md + кросс-языковые тестовые векторы TS/Go (vectors/)
docker-compose.yml    Postgres + MinIO
```

## Документация SDK и эксплуатации

- **Главная страница документации SDK**: [sdk-docs/README.md](sdk-docs/README.md)
- **Быстрый старт за 5 минут**: [sdk-docs/getting-started.md](sdk-docs/getting-started.md)
- **Руководство по Headless TS SDK**: [sdk-docs/headless-sdks.md](sdk-docs/headless-sdks.md)
- **Руководство по WebGPU/WebGL2 + виртуализированным UI SDK**: [sdk-docs/gpu-ui-sdks.md](sdk-docs/gpu-ui-sdks.md)
- **Протокол и спецификация инструментов AI-Native**: [sdk-docs/ai-native-protocol.md](sdk-docs/ai-native-protocol.md)
- **Go бэкенд-SDK, адаптер PostgreSQL и Go CLI/MCP**: [sdk-docs/go-backend-and-cli.md](sdk-docs/go-backend-and-cli.md)
- **Бенчмарки производительности, размеры пакетов и релизы**: [sdk-docs/performance-and-release.md](sdk-docs/performance-and-release.md)
- **Обзор архитектуры Headless SDK**: [headless-sdk.md](headless-sdk.md)
- **Руководство по продакшен-деплою, Helm/K8s и бэкапам**: [deploy/README.md](deploy/README.md)
- **Руководство по E2E-тестированию Playwright**: [e2e/README.md](e2e/README.md)

## Допустимые базовые библиотеки

| Слой | Зависимости |
|---|---|
| Headless & GPU SDK (`packages/*`) | **Ноль сторонних runtime-зависимостей** (чистый ES2022 TypeScript) |
| Go SDK & CLI (`sdk/go`, `sdk/go-pgstore`, `cli`) | **Ноль сторонних runtime-зависимостей** (чистая стандартная библиотека Go 1.23) |
| Веб-приложение (`apps/web`) | react, react-dom, @tanstack/react-query, tailwindcss, shadcn/ui (а также @radix-ui/*, class-variance-authority, clsx, tailwind-merge) |
| Основной сервер (`server/`) | Стандартная библиотека Go (включая собственные реализации SAML 2.0 / LDAP v3 BER / WebAuthn CBOR+COSE / парсинг PDF+OOXML / Prometheus), github.com/jackc/pgx/v5, github.com/coder/websocket |
| Разработка и E2E | vite, typescript, vitest, tsx, @playwright/test |

Без Yjs, Tiptap, ProseMirror, тяжёлых DI-контейнеров, веб-фреймворков и ORM.

## Локальный запуск и эксплуатация

Требования: Node 20+, pnpm 10, Go 1.23+ (для `server/` требуется версия Go из `server/go.mod`), Docker (для Postgres).

```bash
pnpm install
docker compose up -d postgres            # postgres://jiange:jiange@localhost:5432/jiange

cd server && go run ./cmd/jiange         # :8080, при запуске применяет миграции (0001..0092)
# В отдельном терминале
pnpm --filter @jiange/web dev            # http://localhost:5173 (проксирует /api и /scim -> :8080)
```

Резервное копирование, восстановление и переиндексация вложений:

```bash
cd server
go run ./cmd/jiange backup /path/to/jiange-backup.tar.gz
go run ./cmd/jiange restore /path/to/jiange-backup.tar.gz
go run ./cmd/jiange reindex-attachments [workspaceId]
```

Запуск zero-build песочницы WebGPU/WebGL2 + виртуализированных UI SDK:

```bash
pnpm -r build
node examples/ui-playground/serve.mjs    # http://127.0.0.1:4173
```

Переменные окружения: `DATABASE_URL`, `JIANGE_ADDR` (по умолчанию `:8080`), `JIANGE_SESSION_TTL` (по умолчанию `720h`), `JIANGE_SECURE_COOKIES=true` за HTTPS, `JIANGE_SECRET_KEY` (шифрование AES-256-GCM для AI-ключей / секретов SSO / учётных данных коннекторов LDAP-WeCom-DingTalk / секретов вебхуков и каналов уведомлений), `JIANGE_METRICS_TOKEN` (опциональный Bearer-токен для защиты `/metrics`), `JIANGE_AI_EMBEDDING_MODEL` (опциональная удалённая модель `/embeddings`), `JIANGE_OCR_URL` / `JIANGE_OCR_MODE` / `JIANGE_OCR_API_KEY` / `JIANGE_OCR_TESSERACT` (опциональный OCR для изображений и сканированных PDF), `JIANGE_BLOB_DIR` (локальный каталог для блобов, при задании переопределяет S3).

Безопасная отмена ожидающих условных операций документа по умолчанию отключена. При развёртывании сначала примените миграции БД, обновите и остановите все старые инстансы записи документов, а затем включите `JIANGE_ENABLE_CONDITIONAL_CANCEL=true`; после включения не допускайте записи со старых инстансов без поддержки барьера отмены. Подробнее в [docs/deploy.md](docs/deploy.md) и [deploy/README.md](deploy/README.md).

### Хранилище вложений (MinIO / S3)

Задайте `JIANGE_S3_ENDPOINT` (например, `http://localhost:9000`), `JIANGE_S3_ACCESS_KEY`, `JIANGE_S3_SECRET_KEY` и опционально `JIANGE_S3_BUCKET` (по умолчанию `jiange`; создаётся при старте). Если не указан ни S3-эндпоинт, ни `JIANGE_BLOB_DIR`, загрузка файлов отключена. Для docker-compose: `JIANGE_S3_ENDPOINT=http://localhost:9000 JIANGE_S3_ACCESS_KEY=jiange JIANGE_S3_SECRET_KEY=jiange-dev-secret`.

## Тестирование и шлюзы качества

```bash
pnpm lint:names                          # Проверка kebab-case по всему репозиторию (1 960+ отслеживаемых путей)
pnpm -r build && pnpm -r typecheck       # Сборка и проверка типов всех 13 SDK/UI пакетов + apps/web
pnpm test                                # Модульные тесты Vitest (apps/web: 313 файлов / 1 814 тестов)
pnpm test:sdk:coverage                   # Шлюз 100/100/100/100 V8-покрытия для всех 13 TS SDK/UI пакетов
pnpm test:sdk:pack                       # Изолированная проверка Node ESM и типов NodeNext через pnpm pack
pnpm test:e2e                            # Полная браузерная регрессия Playwright (вход/пространства/4 редактора/админка/i18n/офлайн)
pnpm bench                               # Все 7 SLA производительности RFC §7, ноль Canvas 2D и изолированная установка 13 пакетов
pnpm gen:vectors                         # Перегенерация spec/vectors после изменений ядра совместной работы

cd cli && go test -race -cover ./...             # Go CLI и MCP (4 пакета, 100.0% покрытия)
cd sdk/go && go test -race -cover ./...          # Go бэкенд-SDK (10 пакетов, 100.0% покрытия)
cd sdk/go-pgstore && go test -race -cover ./...  # PostgreSQL-адаптер (100.0% покрытия)
cd server && go test ./... && go vet ./...       # Все 20 пакетов сервера Jiange (вкл. 100% соответствие OpenAPI и мульти-реплику)
JIANGE_TEST_DATABASE_URL=postgres://jiange:jiange@localhost:5432/jiange_test?sslmode=disable go test ./internal/store
go test ./collab -run '^$' -fuzz '^FuzzDecode$' -fuzztime 30s
```

Кросс-языковая согласованность: TypeScript генерирует `spec/vectors/encoding.json` (операции ↔ hex-байты) и `scenarios.json` (операции → ожидаемое материализованное состояние, включая 5 случайных 3-репликовых сессий). Go-тесты побайтово сверяют кодирование и проигрывают каждый сценарий в 25 случайных перестановках с дублирующейся доставкой — результат обязан совпадать с TS.

## Аутентификация, наблюдаемость и открытый API

Полный контракт из 361 эндпоинта доступен по адресу `GET /api/openapi.json` либо в интерактивной вкладке «Разработчик / API» панели администратора с копированием команд cURL.

| Метод | Путь | Описание |
|---|---|---|
| GET | `/healthz` · `/readyz` · `/metrics` | Liveness-проба, readiness-проба БД/хранилища и метрики Prometheus 0.0.4 |
| GET | `/api/openapi.json` | Полная спецификация OpenAPI 3.1.0 (361 эндпоинт, 27 моделей данных) |
| GET/POST/PUT/PATCH/DELETE | `/scim/v2/{ServiceProviderConfig,Schemas,ResourceTypes,Users,Groups}` | Синхронизация пользователей и групп по SCIM 2.0 RFC 7643/7644 (PAT с правами `admin`) |
| POST | `/api/auth/register` · `/api/auth/login` · `/api/auth/mfa/verify` · `/api/auth/password-reset/{request,confirm}` | Регистрация, вход по паролю (с rate-limit, TOTP/кодами восстановления и политикой обязательного MFA) и сброс пароля через SMTP |
| POST | `/api/auth/passkey/login/{begin,finish}` | Беспарольный вход через WebAuthn / Passkeys (FIDO2 ES256/RS256) |
| GET/POST | `/api/auth/sso/{slug}/{start,callback,metadata.xml,acs}` | Корпоративный единый вход OIDC / OAuth2 и SAML 2.0 SP |
| GET/POST/DELETE | `/api/me` · `/api/me/password` · `/api/me/sessions` · `/api/me/passkeys` · `/api/me/tokens` | Текущий пользователь, смена пароля, просмотр/отзыв активных сессий, Passkeys и PAT |
| GET/POST/PATCH/DELETE | `/api/workspaces` · `/api/workspaces/{wsId}` | Создание, переключение, переименование, передача прав владельца (`/transfer-owner`), выход (`/leave`) и удаление рабочих пространств |
| GET/PUT/POST | `/api/workspaces/{wsId}/storage` · `/storage/quota` · `/attachments/reindex` | Статистика использования хранилища, лимит квоты (блокировка HTTP 413) и переиндексация текста/OCR вложений |
| POST | `/api/workspaces/{wsId}/org/sync-sources/{sourceId}/pull` | Запуск активной синхронизации каталогов LDAP v3 / WeCom / DingTalk (с поддержкой Dry-Run) |
| POST | `/api/workspaces/{wsId}/dlp/check` · `/retention/run` | Проверка правил DLP в реальном времени и запуск очистки по политике хранения |
| POST | `/api/ai/ask-workspace` · `/api/ai/workspace-ask/stream` · `/api/ai/doc/stream` | Гибридный векторный RAG по рабочему пространству и AI-ассистент документа (с потоковым SSE) |
| GET/POST | `/api/workspaces/{wsId}/webhooks` · `/notification-channels` | HMAC-SHA256 вебхуки для всех 6 типов событий пространства и внешние каналы уведомлений (SMTP/Feishu/DingTalk/WeCom/Slack) |

Сессии: 32-байтный случайный токен, в БД хранится только SHA-256 хэш; cookie `HttpOnly; SameSite=Lax`. Пароли: PBKDF2-HMAC-SHA256 (600 000 итераций, стандартная библиотека Go `crypto/pbkdf2`). Запросы записи требуют `application/json` (в сочетании с SameSite защищает от CSRF, за исключением SAML HTTP-POST ACS и эндпоинтов загрузки файлов с пользовательскими заголовками).

## Дизайн

Интерфейс спроектирован в OpenPencil (`design/jiange.op`), превью находятся в `design/previews/`, переменные дизайна (`design/vars.json`) отображаются на переменные тем Tailwind/shadcn в `apps/web/src/index.css`; промо-ролик экспортирован из нативного `.op`-проекта OpenPencil v0.8.6 (`design/promo/jiange-promo.op`).

## Лицензия

Проект распространяется по покомпонентной лицензии; полный текст см. в [LICENSE](./LICENSE):

- **Прикладная часть (`apps/`, `server/` и др.)**: бесплатно для личного и некоммерческого использования; для коммерческого использования (включая корпоративную производственную эксплуатацию, хостинг/SaaS, интеграцию в коммерческие продукты или платные сервисы) требуется предварительное приобретение коммерческой лицензии.
- **SDK (`packages/*`, `sdk/*`, `cli/*`)**: полностью бесплатно как для личного, так и для коммерческого использования; при доработке, расширении, модификации или создании производных решений на базе SDK в коммерческих организациях необходимо явно указать источник (на базе Jiange SDK) в документации продукта, на странице «О программе» или в описании репозитория.

---

Для файлов и каталогов по умолчанию используется kebab-case, а для идентификаторов кода — конвенции соответствующих языков. Исключения сохранены для суффиксов платформ и тестов Go, уже применённых SQL-миграций, `README.md` / `README.<lang>.md`, `CHANGELOG.md`, `Dockerfile`, `Chart.yaml`, `NOTES.txt`, `_helpers.tpl` и файлов лицензий; проверить отслеживаемые в Git пути можно командой `pnpm lint:names`. В SDK сохранены прежние camelCase-подпути для обратной совместимости; в новом коде используйте kebab-case.
