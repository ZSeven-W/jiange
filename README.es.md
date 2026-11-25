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
  <b>Español</b>
</p>

<p align="center">
  <strong>Suite colaborativa de código abierto completa: Documentos + Hojas de cálculo + Tablas multidimensionales + Presentaciones + Pizarra/Mapas mentales (alternativa a Feishu/Lark)</strong><br />
  <sub>Nativa de IA · Ligera y modular · Seguridad y cumplimiento empresarial/gubernamental · Alta disponibilidad multirréplica · Internacionalización bilingüe completa y CRDT sin conexión · Cero Canvas 2D (WebGPU/WebGL2 + lista virtual)</sub>
</p>

<p align="center">
  Una alternativa de código abierto, autoalojable, lista para empresas y nativa de IA frente a Feishu/Lark Docs, Sheets, Base, Slides y Whiteboard/MindMap — construida desde cero con un motor CRDT propio, un backend en Go basado puramente en la biblioteca estándar (SAML 2.0, OIDC, SCIM 2.0, LDAP/WeCom/DingTalk, WebAuthn Passkeys, DLP, Prometheus, OpenAPI 3.1), 13 SDK de TypeScript/WebGPU sin dependencias y un CLI en Go y servidor MCP en un único binario.
</p>

---

## Video de lanzamiento

<p align="center">
  <a href="design/promo/jiange-promo.mp4">
    <img src="design/promo/jiange-promo-cover.png" alt="Video promocional de Jiange — haz clic para ver" width="100%" />
  </a>
</p>

<p align="center">
  <sub>
    ▶ <a href="design/promo/jiange-promo.mp4"><b>Ver el video promocional completo (MP4 · 30s · con música original)</b></a><br />
    Animaciones creadas y exportadas de forma nativa desde un proyecto <code>.op</code> en <b>OpenPencil v0.8.6</b> (<a href="design/promo/jiange-promo.op"><code>design/promo/jiange-promo.op</code></a> / <a href="design/promo/build-jiange-promo.py">script de generación</a>); banda sonora instrumental generada localmente con el modelo <b>MiniMax H3-Music</b>.
  </sub>
</p>

---

## Capacidades principales de la suite

| Módulo | Capacidades clave |
|---|---|
| **Documentos en la nube (Doc)** | Colaboración en tiempo real mediante CRDT RGA/Fugue propio, **edición colaborativa CRDT sin conexión avanzada con fusión automática al reconectar** (persistencia de réplicas en IndexedDB), 15+ tipos de bloques (incluyendo `audio` / `video` nativos, `poll` encuestas en tiempo real, `countdown` temporizadores, `tabs` pestañas, tablas, bloques de código, fórmulas, Mermaid, bloques sincronizados, multicolumna y tablas incrustadas), **control de cambios en línea (Track Changes)**, comentarios sobre selección y reacciones con emojis, lectura guiada, historial de versiones, importación/exportación DOCX / Markdown (con imágenes) e impresión a PDF |
| **Hojas de cálculo (Sheet)** | Cuadrícula virtual WebGPU/WebGL2 para millones de filas, **148 funciones de fórmulas integradas** (incluyendo `XLOOKUP` / `FILTER` / `SORT` / `UNIQUE` / `LET` / `LAMBDA` / `ARRAYFORMULA` / `QUERY` / `REGEX*` / `IMAGE`), gráficos flotantes, tablas dinámicas, **minigráficos SVG en línea (Sparklines)**, agrupación plegable de filas y columnas, imágenes en celdas, formato condicional / validación de datos / rangos protegidos, rangos con nombre en la nube, historial de versiones y registro de cambios por celda, fusión incremental de celdas sin conexión, importación/exportación XLSX/CSV y **asistente de fórmulas con IA** |
| **Tablas multidimensionales (Base)** | Múltiples tablas y relaciones bidireccionales entre tablas, **23 tipos de campo** (incluyendo moneda, progreso, numeración automática, botón de acción, geolocalización, fórmula, relación y búsqueda/lookup), **7 vistas** (Cuadrícula, Kanban, Gantt con líneas de dependencia, Calendario, Galería, **vista de árbol jerárquico** y formularios públicos con ramificación condicional), agrupación anidada hasta 3 niveles, flujos de automatización multipaso, paneles de datos, RBAC multigranular por fila y columna con múltiples roles, importación/exportación XLSX/CSV y **relleno masivo por columna con IA** |
| **Presentaciones (Slides)** | Lienzo WebGPU/WebGL2, **diapositivas maestras y kit de marca (Master Brand Kit)**, formas de texto/gráficos/tablas/diagramas/video/audio, recorte de imágenes, animaciones elemento por elemento y transiciones entre diapositivas, modo presentador (puntero láser / anotaciones con lápiz + **seguimiento en tiempo real para la audiencia** mediante WebSocket), comentarios por diapositiva o elemento, historial de versiones, fusión sin conexión de borradores de diapositivas, importación/exportación PPTX e impresión a PDF |
| **Pizarra y mapas mentales** | Lienzo infinito, diagramas de flujo y carriles (swimlanes), notas adhesivas de lluvia de ideas / resaltador / votación por puntos / temporizador / minimapa / marcos de agrupación, mapas mentales multiestructura, contornos / resúmenes / insignias, sincronización bidireccional con el esquema y exportación a Mermaid / XMind / SVG / PNG |
| **Base de conocimiento, Drive y búsqueda de texto completo** | **Ciclo de vida completo multiespacio de trabajo** (creación, cambio en un clic, renombrado, transferencia de propiedad desde UI/API, salida de miembros y eliminación), espacios de conocimiento independientes y árboles de directorios multinivel, accesos directos, **movimiento entre espacios (personal / compartido / entre espacios de trabajo)**, **panel de uso de almacenamiento y control de cuota (HTTP 413)**, **vista previa en línea multiformato** (zoom y rotación de imágenes, PDF, audio/video, código/Markdown/CSV, `.docx`/`.xlsx`/`.pptx`, incluida vista previa enriquecida de adjuntos en documentos públicos de solo lectura), **extracción de texto completo en adjuntos escrita en Go puro + OCR conectable (HTTP / OpenAI Vision / `tesseract`) + reindexación retroactiva en un clic o por CLI de adjuntos existentes** |
| **Espacio de trabajo nativo de IA** | **Preguntas y respuestas RAG híbridas (vectores semánticos + BM25) sobre todo el espacio de conocimiento** (vectores locales de 128 dimensiones + `/embeddings` remoto opcional + aislamiento de permisos + citas de origen para documentos y adjuntos PDF/Office/OCR), **streaming SSE palabra por palabra de doble canal para todo el espacio y documento individual** (`POST /api/ai/workspace-ask/stream` · `POST /api/ai/doc/stream`), generación de fórmulas con IA en hojas de cálculo, relleno masivo con IA en Base, integración multimodelo compatible con OpenAI / Anthropic (con degradación automática al motor local si no hay clave API) |
| **Identidad empresarial y sincronización de directorios (IAM)** | **OIDC / OAuth2 + SAML 2.0 SP** (Metadata XML, AuthnRequest, verificación nativa de firmas XML-DSig RSA/ECDSA y protección XXE/XSW), **SCIM 2.0 (implementación completa RFC 7644)** (`ServiceProviderConfig`, `Schemas`, `ResourceTypes`, operaciones completas de `Users`/`Groups` con `PUT`/`PATCH`/`DELETE`/filtrado/paginación), **extracción activa y sincronización programada para LDAP v3 / WeCom / DingTalk** (cliente ASN.1 BER nativo + credenciales cifradas), **MFA TOTP + 8 códigos de recuperación + política MFA obligatoria por espacio de trabajo con banner superior global**, **inicio de sesión sin contraseña WebAuthn / Passkeys (FIDO2 ES256/RS256)** y **ciclo completo de autoservicio de seguridad de cuenta** (limitación de tasa contra fuerza bruta en login/MFA/Passkey/enlaces públicos, cambio de contraseña, recuperación/restablecimiento por SMTP, lista de sesiones activas y cierre remoto) |
| **Seguridad, cumplimiento y ecosistema abierto** | **DLP empresarial con palabras sensibles y expresiones regulares RE2 seguras** (cobertura para Doc / Sheet / Base / Slides / Survey, bloqueo o alerta en compartición pública y exportaciones CSV/adjuntos públicos), **políticas de retención de datos con limpieza programada en segundo plano o manual**, marcas de agua antifugas en toda la suite, contraseñas en enlaces públicos, registros de auditoría de seguridad empresarial con exportación CSV, **contrato OpenAPI 3.1.0 completo (361 endpoints con verificación de cobertura de rutas al 100% + 27 modelos de datos + portal interactivo para desarrolladores)**, **tokens de acceso personal (PAT)**, **webhooks HMAC-SHA256 para las 6 categorías de eventos del espacio** y **canales de notificación externos** (SMTP / Feishu / DingTalk / WeCom / Slack) |
| **Alta disponibilidad, internacionalización y despliegue nativo en la nube** | **Escalado horizontal multirréplica en los 4 hubs de colaboración en tiempo real** (Doc `syncsrv` / Base `btsync` / Sheet `sheetsync` / Slides `slidessync`, todos con difusión entre nodos vía Postgres `LISTEN/NOTIFY`), **internacionalización bilingüe completa chino/inglés en todo el repositorio** (5,332 entradas, 0 omisiones visibles para el usuario), **`React.lazy` por ruta + división de paquetes con Rollup** (paquete principal de 308 KB / gzip 84 KB), edición sin conexión PWA + IndexedDB con fusión automática al reconectar (Doc / Base / Sheet / Slides), `/healthz` + `/readyz` + Prometheus `/metrics` + W3C `traceparent`, CLI de copia de seguridad y restauración completa verificada con SHA-256 (`jiange backup` / `restore` / `reindex-attachments`), **Helm Chart** y manifiestos **Kustomize** listos para producción |

---

## Estructura del repositorio

```text
apps/web              Frontend web principal de Jiange (React + Vite + TS + TanStack Query + Tailwind + shadcn/ui)
server/               Backend principal en Go de Jiange: cmd/jiange, internal/{api,auth,backup,blob,btformula,btquery,btsync,config,httpx,migrate,sheetstore,sheetsync,slidessync,store,syncsrv,tableadmission}, collab
packages/
  ooxml               L0: ZIP síncrono STORE + DEFLATE asíncrono sin dependencias y XML seguro acotado
  collab              L0: Núcleo colaborativo (CRDT RGA/Fugue, hidratación de instantáneas sin conexión y fusión automática, Undo, ./table, ./ws, ./storage, ./ai-agent)
  sheet-sdk           L1: SDK headless AI-Native para hojas de cálculo (motor incremental AST+DAG con 148 funciones, XLSX/CSV, Worker)
  doc-sdk             L1: SDK headless AI-Native para documentos (Document Facade, MD/HTML/DOCX, comentarios y revisiones)
  slides-sdk          L1: SDK headless AI-Native para presentaciones (Presentation, PPTX, SVG 16:9 en TS puro, medios y recorte)
  whiteboard-sdk      L1: SDK headless AI-Native para pizarra/mapas mentales (Board, Mermaid bidireccional, diseño DAG, XMind, SVG)
  base-sdk            L1: SDK headless AI-Native sin dependencias para tablas multidimensionales (23 campos, 7 vistas, fórmulas, relaciones/lookup, paneles, CSV)
  render-gpu          L2: Núcleo de renderizado cero Canvas 2D (WebGPU/WebGL2 SDF+GlyphAtlas, lista virtual Fenwick de millones de filas, SpatialIndex)
  {sheet,doc,slides,whiteboard,base}-ui
                      L2: 5 SDK de UI independientes y ligeros (mount nativo, ./react, Web Components <jiange-*>)
cli/                  CLI nativo en Go 1.23 sin dependencias externas y servidor MCP Streamable HTTP/stdio (binario estático único ~5.5 MB)
sdk/go/               SDK backend embebible en Go 1.23 sin dependencias externas (10 paquetes: storage, sync, 5 motores de dominio, ai, server, client)
sdk/go-pgstore/       Adaptador opcional de PostgreSQL para storage.Store (database/sql estándar, compatible con pgx/v5/stdlib y lib/pq)
sdk-docs/             Guías completas de SDK, referencia de API, protocolo AI-Native, UI WebGPU y documentación de integración Go
deploy/               Helm Chart de Kubernetes listo para producción (deploy/helm/jiange), manifiestos Kustomize (deploy/k8s) y manual operativo
e2e/                  Suite automatizada de pruebas de regresión de extremo a extremo en navegador con Playwright (integrada con el pipeline CI `e2e` de GitHub Actions)
benchmarks/           SLA de rendimiento cuantificados RFC §7, tamaño de paquetes, cero Canvas 2D y compuertas automatizadas de instalación aislada de los 13 paquetes
examples/             Ejemplos ejecutables: ts-headless, go-backend, ui-playground WebGPU/WebGL2 sin compilación
design/               Archivos fuente de diseño en OpenPencil (jiange.op) y proyecto de video promocional (promo/jiange-promo.op + mp4)
spec/                 Especificación del protocolo colaborativo PROTOCOL.md + vectors/ vectores de conformidad entre TS y Go
docker-compose.yml    Postgres + MinIO
```

## Documentación de SDK y operaciones

- **Portada de documentación de SDK**: [sdk-docs/README.md](sdk-docs/README.md)
- **Inicio rápido en 5 minutos**: [sdk-docs/getting-started.md](sdk-docs/getting-started.md)
- **Guía de SDK TypeScript Headless**: [sdk-docs/headless-sdks.md](sdk-docs/headless-sdks.md)
- **Guía de SDK de UI WebGPU/WebGL2 + lista virtual**: [sdk-docs/gpu-ui-sdks.md](sdk-docs/gpu-ui-sdks.md)
- **Especificación del protocolo y herramientas AI-Native**: [sdk-docs/ai-native-protocol.md](sdk-docs/ai-native-protocol.md)
- **SDK backend Go, adaptador PostgreSQL y CLI/MCP Go**: [sdk-docs/go-backend-and-cli.md](sdk-docs/go-backend-and-cli.md)
- **Pruebas de rendimiento, tamaños de paquetes y guía de publicación**: [sdk-docs/performance-and-release.md](sdk-docs/performance-and-release.md)
- **Resumen general y arquitectura**: [headless-sdk.md](headless-sdk.md)
- **Despliegue en producción, Helm/K8s y copias de seguridad/restauración**: [deploy/README.md](deploy/README.md)
- **Manual de pruebas E2E con Playwright**: [e2e/README.md](e2e/README.md)

## Bibliotecas base permitidas

| Capa | Dependencias |
|---|---|
| SDK Headless y GPU (`packages/*`) | **Cero dependencias de ejecución de terceros** (TypeScript ES2022 puro) |
| SDK Go y CLI (`sdk/go`, `sdk/go-pgstore`, `cli`) | **Cero dependencias de ejecución de terceros** (biblioteca estándar de Go 1.23 pura) |
| Aplicación web (`apps/web`) | `react`, `react-dom`, `@tanstack/react-query`, `tailwindcss`, `shadcn/ui` (y sus `@radix-ui/*`, `class-variance-authority`, `clsx`, `tailwind-merge`) |
| Servidor principal (`server/`) | Biblioteca estándar de Go (incluyendo SAML 2.0 / LDAP v3 BER / WebAuthn CBOR+COSE / extracción PDF+OOXML / Prometheus en Go puro), `github.com/jackc/pgx/v5`, `github.com/coder/websocket` |
| Desarrollo y E2E | `vite`, `typescript`, `vitest`, `tsx`, `@playwright/test` |

No utiliza Yjs, Tiptap, ProseMirror ni ningún contenedor de inyección de dependencias pesado, framework web u ORM.

## Ejecución local y operaciones en producción

Requisitos: Node 20+, pnpm 10, Go 1.23+ (`server/` requiere una versión de Go acorde a `server/go.mod`), Docker (para Postgres).

```bash
pnpm install
docker compose up -d postgres            # postgres://jiange:jiange@localhost:5432/jiange

cd server && go run ./cmd/jiange         # :8080, ejecuta las migraciones (0001..0092) al iniciar
# En otra terminal
pnpm --filter @jiange/web dev            # http://localhost:5173 (proxy de /api y /scim -> :8080)
```

Copia de seguridad, restauración de datos y reindexación de texto completo de adjuntos:

```bash
cd server
go run ./cmd/jiange backup /path/to/jiange-backup.tar.gz
go run ./cmd/jiange restore /path/to/jiange-backup.tar.gz
go run ./cmd/jiange reindex-attachments [workspaceId]
```

Probar el playground sin compilación de los SDK de UI WebGPU/WebGL2 + lista virtual:

```bash
pnpm -r build
node examples/ui-playground/serve.mjs    # http://127.0.0.1:4173
```

Variables de entorno: `DATABASE_URL`, `JIANGE_ADDR` (`:8080` por defecto), `JIANGE_SESSION_TTL` (`720h` por defecto), `JIANGE_SECURE_COOKIES=true` detrás de HTTPS, `JIANGE_SECRET_KEY` (sellado AES-256-GCM para claves de IA / secretos SSO / credenciales de conectores LDAP-WeCom-DingTalk / secretos de webhooks y canales de notificación), `JIANGE_METRICS_TOKEN` (token Bearer opcional que protege `/metrics`), `JIANGE_AI_EMBEDDING_MODEL` (nombre de modelo opcional para `/embeddings` remoto), `JIANGE_OCR_URL` / `JIANGE_OCR_MODE` / `JIANGE_OCR_API_KEY` / `JIANGE_OCR_TESSERACT` (OCR opcional para imágenes y PDF escaneados), `JIANGE_BLOB_DIR` (directorio local en disco para blobs; anula S3 cuando está definido).

La detención segura de operaciones pendientes de confirmación en documentos está desactivada por defecto. Al desplegar, aplica primero las migraciones de base de datos, actualiza y drena todas las instancias antiguas que escriban documentos y solo entonces define `JIANGE_ENABLE_CONDITIONAL_CANCEL=true`; una vez habilitada, las instancias antiguas que no admitan la barrera de detención no deben volver a escribir. Consulta [docs/deploy.md](docs/deploy.md) y [deploy/README.md](deploy/README.md).

### Archivos adjuntos (MinIO / S3)

Configura `JIANGE_S3_ENDPOINT` (p. ej. `http://localhost:9000`), `JIANGE_S3_ACCESS_KEY`, `JIANGE_S3_SECRET_KEY` y opcionalmente `JIANGE_S3_BUCKET` (`jiange` por defecto; se crea al iniciar). Sin un endpoint S3 (o `JIANGE_BLOB_DIR`), las cargas quedan deshabilitadas. Con `docker-compose`: `JIANGE_S3_ENDPOINT=http://localhost:9000 JIANGE_S3_ACCESS_KEY=jiange JIANGE_S3_SECRET_KEY=jiange-dev-secret`.

## Pruebas y controles de calidad

```bash
pnpm lint:names                          # Validación kebab-case en todo el repositorio (1,960+ rutas rastreadas)
pnpm -r build && pnpm -r typecheck       # Compilación y verificación de tipos de los 13 paquetes SDK/UI + apps/web
pnpm test                                # Pruebas unitarias Vitest en todo el repositorio (apps/web: 313 archivos / 1,814 casos)
pnpm test:sdk:coverage                   # Compuerta de cobertura V8 100/100/100/100 en los 13 paquetes SDK/UI de TS
pnpm test:sdk:pack                       # Validación real con pnpm pack en aislamiento Node ESM y tipado NodeNext
pnpm test:e2e                            # Suite completa de regresión E2E en navegador con Playwright (login/espacio/4 apps/admin/bilingüe/sin conexión)
pnpm bench                               # Validación de los 7 SLA de rendimiento RFC §7, cero Canvas 2D e instalación aislada de los 13 paquetes
pnpm gen:vectors                         # Regenera spec/vectors tras modificar el núcleo colaborativo

cd cli && go test -race -cover ./...             # CLI y MCP en Go (4 paquetes, 100.0% de cobertura)
cd sdk/go && go test -race -cover ./...          # SDK backend en Go (10 paquetes, 100.0% de cobertura)
cd sdk/go-pgstore && go test -race -cover ./...  # Adaptador PostgreSQL (100.0% de cobertura)
cd server && go test ./... && go vet ./...       # Suite completa de los 20 paquetes del servidor principal de Jiange (incluida consistencia de rutas OpenAPI al 100% y sincronización multirréplica)
JIANGE_TEST_DATABASE_URL=postgres://jiange:jiange@localhost:5432/jiange_test?sslmode=disable go test ./internal/store
go test ./collab -run '^$' -fuzz '^FuzzDecode$' -fuzztime 30s
```

Consistencia entre lenguajes: TypeScript genera `spec/vectors/encoding.json` (operaciones ↔ bytes hexadecimales) y `scenarios.json` (operaciones → vista materializada esperada, incluidas 5 sesiones aleatorias de 3 réplicas). Las pruebas de Go comparan la codificación byte a byte y reproducen cada escenario bajo 25 permutaciones aleatorias de desorden y entregas duplicadas; los resultados deben coincidir de manera idéntica con TypeScript.

## Autenticación, observabilidad y API abierta

El contrato completo de 361 endpoints puede consultarse directamente en `GET /api/openapi.json` o explorarse de forma interactiva con comandos cURL copiables desde la pestaña «Desarrollador / API» de la consola de administración.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/healthz` · `/readyz` · `/metrics` | Sonda de actividad, sonda de disponibilidad de BD/almacenamiento y métricas Prometheus 0.0.4 |
| GET | `/api/openapi.json` | Especificación OpenAPI 3.1.0 completa (361 endpoints, 27 modelos de datos) |
| GET/POST/PUT/PATCH/DELETE | `/scim/v2/{ServiceProviderConfig,Schemas,ResourceTypes,Users,Groups}` | Sincronización SCIM 2.0 (RFC 7643/7644) de miembros y grupos de la organización (PAT con ámbito `admin`) |
| POST | `/api/auth/register` · `/api/auth/login` · `/api/auth/mfa/verify` · `/api/auth/password-reset/{request,confirm}` | Registro, inicio de sesión con contraseña (con limitación de tasa, verificación en dos pasos TOTP/códigos de recuperación y política MFA obligatoria) y restablecimiento SMTP |
| POST | `/api/auth/passkey/login/{begin,finish}` | Inicio de sesión sin contraseña mediante WebAuthn / Passkeys (FIDO2 ES256/RS256) |
| GET/POST | `/api/auth/sso/{slug}/{start,callback,metadata.xml,acs}` | Inicio de sesión único (SSO) empresarial OIDC / OAuth2 y SAML 2.0 SP |
| GET/POST/DELETE | `/api/me` · `/api/me/password` · `/api/me/sessions` · `/api/me/passkeys` · `/api/me/tokens` | Usuario actual, cambio de contraseña, gestión/cierre remoto de sesiones de dispositivos activos, Passkeys y tokens PAT |
| GET/POST/PATCH/DELETE | `/api/workspaces` · `/api/workspaces/{wsId}` | Creación multiespacio de trabajo, cambio, renombrado, transferencia de propiedad (`/transfer-owner`), salida (`/leave`) y eliminación |
| GET/PUT/POST | `/api/workspaces/{wsId}/storage` · `/storage/quota` · `/attachments/reindex` | Panel de uso de almacenamiento, límite de cuota (rechazo HTTP 413) y reindexación de texto completo/OCR de adjuntos existentes |
| POST | `/api/workspaces/{wsId}/org/sync-sources/{sourceId}/pull` | Ejecución de extracción activa de directorio LDAP v3 / WeCom / DingTalk (con soporte Dry-Run) |
| POST | `/api/workspaces/{wsId}/dlp/check` · `/retention/run` | Prueba en tiempo real de palabras/regex DLP empresariales y ejecución inmediata de limpieza por retención de datos |
| POST | `/api/ai/ask-workspace` · `/api/ai/workspace-ask/stream` · `/api/ai/doc/stream` | Preguntas y respuestas RAG vectorial híbrido en todo el espacio y redacción con IA en un documento (ambos con streaming SSE palabra por palabra) |
| GET/POST | `/api/workspaces/{wsId}/webhooks` · `/notification-channels` | Webhooks HMAC-SHA256 para las 6 categorías de eventos del espacio y canales de notificación externos (SMTP / Feishu / DingTalk / WeCom / Slack) |

Sesiones: token aleatorio de 32 bytes almacenado únicamente como hash SHA-256; cookie `HttpOnly; SameSite=Lax`. Contraseñas: PBKDF2-HMAC-SHA256 (600k iteraciones, biblioteca estándar Go `crypto/pbkdf2`). Las solicitudes de escritura deben usar `application/json` (junto con `SameSite` para protección CSRF, salvo el endpoint ACS de SAML HTTP-POST y los endpoints de carga con encabezados personalizados).

## Diseño

La interfaz de usuario se diseña primero en OpenPencil (`design/jiange.op`), con vistas previas en `design/previews/`, y las variables de diseño (`design/vars.json`) se asignan a las variables de tema de Tailwind/shadcn en `apps/web/src/index.css`. El video promocional se exporta de forma nativa desde las animaciones `.op` de OpenPencil v0.8.6 (`design/promo/jiange-promo.op`).

## Licencia

Este proyecto adopta un esquema de licencia por componentes; consulta las condiciones completas en [LICENSE](./LICENSE):

- **Parte de aplicación (`apps/`, `server/`, etc.)**: gratuita para uso personal y no comercial; el uso comercial (incluida la operación interna en producción empresarial, alojamiento/SaaS, integración en productos comerciales o servicios de pago, etc.) requiere adquirir previamente una licencia comercial.
- **Parte de SDK (`packages/*`, `sdk/*`, `cli/*`)**: gratuita tanto para uso personal como comercial; si una empresa realiza desarrollo secundario sobre los SDK (modificación, ampliación, recorte o derivación a partir del código fuente), debe indicar claramente el origen (basado en Jiange SDK) en un lugar público como la documentación del producto, la página «Acerca de» o la descripción del repositorio fuente.

---

Los archivos y directorios usan kebab-case por defecto, mientras que los identificadores de código siguen las convenciones de cada lenguaje. Los sufijos de plataforma y pruebas de Go, los nombres de migraciones de base de datos ya aplicadas, `README.md` / `README.<lang>.md`, `CHANGELOG.md`, `Dockerfile`, `Chart.yaml`, `NOTES.txt`, `_helpers.tpl` y los archivos de licencia conservan las convenciones de sus herramientas; `pnpm lint:names` verifica las rutas rastreadas por Git. Los SDK mantienen las antiguas subrutas camelCase por compatibilidad; el código nuevo debe usar subrutas en kebab-case.
