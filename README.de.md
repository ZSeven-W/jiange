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
  <b>Deutsch</b> ·
  <a href="README.es.md">Español</a>
</p>

<p align="center">
  <strong>Vollständige Open-Source-Kollaborationssuite für Cloud-Dokumente + Tabellenkalkulation + multidimensionale Tabellen + Präsentationen + Whiteboard/Mindmap (Alternative zu Feishu/Lark)</strong><br />
  <sub>KI-nativ · Schlank &amp; modular · Enterprise- &amp; Behörden-Compliance · Multi-Replikat-Hochverfügbarkeit · Zweisprachige Voll-i18n &amp; Offline-CRDT · Null Canvas 2D (WebGPU/WebGL2 + virtuelle Liste)</sub>
</p>

<p align="center">
  Eine quelloffene, selbst hostbare, unternehmensreife und KI-native Alternative zu Feishu/Lark Docs, Sheets, Base, Slides und Whiteboard/MindMap — von Grund auf neu entwickelt mit eigener CRDT-Engine, rein auf der Go-Standardbibliothek basierendem Backend (SAML 2.0, OIDC, SCIM 2.0, LDAP/WeCom/DingTalk, WebAuthn Passkeys, DLP, Prometheus, OpenAPI 3.1), 13 abhängigkeitsfreien TypeScript/WebGPU-SDKs sowie einer Go-CLI &amp; einem MCP-Server als einzelne Binärdatei.
</p>

---

## Launch-Video

<p align="center">
  <a href="design/promo/jiange-promo.mp4">
    <img src="design/promo/jiange-promo-cover.png" alt="Jiange Promo-Video — zum Abspielen klicken" width="100%" />
  </a>
</p>

<p align="center">
  <sub>
    ▶ <a href="design/promo/jiange-promo.mp4"><b>Vollständiges Promo-Video ansehen (MP4 · 30s · inkl. Original-Soundtrack)</b></a><br />
    Motion-Grafiken erstellt und nativ exportiert aus einem <code>.op</code>-Projekt in <b>OpenPencil v0.8.6</b> (<a href="design/promo/jiange-promo.op"><code>design/promo/jiange-promo.op</code></a> / <a href="design/promo/build-jiange-promo.py">Generierungsskript</a>); Instrumentalmusik lokal generiert mit dem Modell <b>MiniMax H3-Music</b>.
  </sub>
</p>

---

## Kernfunktionen der Suite

| Modul | Kernfunktionen |
|---|---|
| **Cloud-Dokumente (Doc)** | Echtzeit-Kollaboration auf Basis einer eigenen RGA/Fugue-CRDT-Engine, **tief integrierte Offline-CRDT-Bearbeitung mit automatischem Merge bei Wiederverbindung** (IndexedDB-Replikatpersistenz), 15+ Blocktypen (inkl. nativem `audio` / `video` / `poll` Echtzeit-Umfragen / `countdown` Timer / `tabs` Registerkarten / Tabellen / Codeblöcken / Formeln / Mermaid / synchronisierten Blöcken / Mehrspaltigkeit / eingebetteten Tabellen), **Inline-Änderungsverfolgung (Track Changes)**, Textmarkierungs-Kommentare und Emoji-Reaktionen, Mitlese-Modus, Versionsverlauf, DOCX-/Markdown-Import/-Export (inkl. Bildern) sowie PDF-Druck |
| **Tabellenkalkulation (Sheet)** | Virtuelles WebGPU/WebGL2-Raster für Millionen Zeilen, **148 integrierte Formelfunktionen** (inkl. `XLOOKUP` / `FILTER` / `SORT` / `UNIQUE` / `LET` / `LAMBDA` / `ARRAYFORMULA` / `QUERY` / `REGEX*` / `IMAGE`), schwebende Diagramme, Pivot-Tabellen, **Inline-SVG-Sparklines**, einklappbare Zeilen-/Spaltengruppen, Bilder in Zellen, bedingte Formatierung / Datenvalidierung / geschützte Bereiche, Cloud-benannte Bereiche, Versionsverlauf und Zellen-Änderungsprotokoll, inkrementeller Offline-Zellen-Merge, XLSX-/CSV-Import/-Export, **KI-Formelassistent für Tabellen** |
| **Multidimensionale Tabellen (Base)** | Mehrere Tabellen und bidirektionale tabellenübergreifende Verknüpfungen, **23 Feldtypen** (inkl. Währung, Fortschritt, automatischer Nummerierung, Aktions-Button, Geoposition, Formel, Verknüpfung, Lookup), **7 Ansichten** (Raster, Kanban, Gantt inkl. Abhängigkeitslinien, Kalender, Galerie, **hierarchische Baumansicht**, öffentliche Formulare mit bedingter Verzweigung), bis zu 3-stufig verschachtelte Gruppierungen, mehrstufige Automatisierungs-Workflows, Daten-Dashboards, rollenbasiertes feingranulares Zeilen-/Spalten-RBAC, XLSX-/CSV-Import/-Export, **KI-gestütztes Stapelausfüllen nach Spalten** |
| **Präsentationen (Slides)** | WebGPU/WebGL2-Canvas, **Folienmaster & Marken-Kit (Master Brand Kit)**, Text-/Form-/Tabellen-/Diagramm-/Video-/Audio-Elemente, Bildzuschnitt, Element-für-Element-Animationen und Folienübergänge, Referentenmodus (Laserpointer / Stift-Anmerkungen + WebSocket-basiertes **Live-Mitfolgen für das Publikum**), Folien- und Elementkommentare, Versionsverlauf, Offline-Merge für Folienentwürfe, PPTX-Import/-Export und PDF-Druck |
| **Whiteboard & Mindmap** | Unendliche Zeichenfläche, Flussdiagramme und Swimlanes, Brainstorming-Haftnotizen / Textmarker / Punkt-Abstimmung / Countdown / Minimap / Gruppierungsrahmen, mehrstrukturige Mindmaps, Rahmen / Zusammenfassungen / Badges, bidirektionale Synchronisation mit der Gliederung, Export als Mermaid / XMind / SVG / PNG |
| **Wissensdatenbank, Drive & Volltextsuche** | **Vollständiger Multi-Workspace-Lebenszyklus** (Erstellen, Ein-Klick-Wechsel, Umbenennen, Eigentumsübertragung per UI/API, Austritt von Mitgliedern, Löschen), eigenständige Wissensbereiche und mehrstufige Verzeichnishierarchien, Verknüpfungen, **bereichsübergreifendes Verschieben (persönlich / geteilt / über Workspaces hinweg)**, **Speichernutzungs-Dashboard und Kontingentdurchsetzung (HTTP 413)**, **Online-Vorschau für alle Formate** (Bildzoom/-rotation, PDF, Audio/Video, Code/Markdown/CSV, `.docx`/`.xlsx`/`.pptx`, inkl. Rich-Vorschau für Anhänge in öffentlichen schreibgeschützten Dokumenten), **reine Go-Volltextextraktion für Anhänge + austauschbares OCR (HTTP / OpenAI Vision / `tesseract`) + Ein-Klick-/CLI-Nachindizierung bestehender Anhänge** |
| **KI-nativer Arbeitsbereich** | **Hybride semantische Vektor- + BM25-RAG-Wissensabfrage über den gesamten Workspace** (128-dimensionale lokale Vektoren + optionales Remote-`/embeddings` + Berechtigungsisolation + Quellenangaben für Dokumente sowie PDF-/Office-/OCR-Anhänge), **zweigleisiges SSE-Token-Streaming für gesamten Workspace und Einzeldokumente** (`POST /api/ai/workspace-ask/stream` · `POST /api/ai/doc/stream`), KI-Formelgenerierung in Tabellen, KI-Stapelausfüllen in Base, OpenAI-/Anthropic-kompatible Multimodell-Anbindung (automatischer Fallback auf lokale Engine ohne API-Schlüssel) |
| **Enterprise-IAM & Verzeichnissynchronisation** | **OIDC / OAuth2 + SAML 2.0 SP** (Metadata-XML, AuthnRequest, native XML-DSig-RSA/ECDSA-Signaturprüfung sowie XXE-/XSW-Schutz), **SCIM 2.0 (vollständige RFC-7644-Implementierung)** (`ServiceProviderConfig`, `Schemas`, `ResourceTypes`, vollständiges `Users`/`Groups`-`PUT`/`PATCH`/`DELETE`/Filtern/Paginieren), **aktiver Pull und zeitgesteuerte Synchronisation für LDAP v3 / WeCom / DingTalk** (nativer ASN.1-BER-Client + verschlüsselte Zugangsdaten), **TOTP-MFA + 8 Wiederherstellungscodes + verbindliche Workspace-MFA-Richtlinie mit globalem Hinweisbanner**, **passwortlose Anmeldung über WebAuthn / Passkeys (FIDO2 ES256/RS256)**, **vollständiger Self-Service-Kreislauf für Kontosicherheit** (Brute-Force-Ratenbegrenzung für Login/MFA/Passkey/öffentliche Links, Passwortänderung, SMTP-Passwort-Reset, Liste aktiver Sitzungsgeräte und Remote-Abmeldung) |
| **Sicherheit, Compliance & offenes Ökosystem** | **Enterprise-DLP mit sensiblen Schlüsselwörtern und sicheren RE2-Regulärausdrücken** (für Doc / Sheet / Base / Slides / Survey, Blockieren/Warnen bei öffentlichem Teilen sowie CSV-/öffentlichem Anhangsexport), **Datenaufbewahrungsrichtlinien mit zeitgesteuerter Hintergrund- und manueller Bereinigung**, suiteweite Wasserzeichen zum Schutz vor Datenabfluss, Passwortschutz für öffentliche Freigaben, Enterprise-Sicherheitsaudit-Logs mit CSV-Export, **vollständiger OpenAPI-3.1.0-Vertrag (361 Endpunkte mit 100-%-Routenabdeckungsprüfung + 27 Datenmodelle + interaktives Entwicklerportal)**, **Personal Access Tokens (PAT)**, **HMAC-SHA256-Webhooks für alle 6 Workspace-Ereigniskategorien**, **externe Benachrichtigungskanäle** (SMTP / Feishu / DingTalk / WeCom / Slack) |
| **Hochverfügbarkeit, Internationalisierung & Cloud-Native** | **Horizontale Multi-Replikat-Skalierung aller 4 Echtzeit-Kollaborations-Hubs** (Doc `syncsrv` / Base `btsync` / Sheet `sheetsync` / Slides `slidessync`, alle über Postgres `LISTEN/NOTIFY` knotenübergreifend verteilt), **vollständige zweisprachige i18n (Chinesisch/Englisch) im gesamten Repository** (5.332 Einträge, 0 nutzersichtbare Lücken), **routenbasiertes `React.lazy` + Rollup-Code-Splitting** (Hauptbundle 308 KB / gzip 84 KB), PWA + IndexedDB Offline-Bearbeitung mit automatischem Merge bei Wiederverbindung (Doc / Base / Sheet / Slides), `/healthz` + `/readyz` + Prometheus `/metrics` + W3C `traceparent`, SHA-256-verifizierte Voll-Backup-/Restore-CLI (`jiange backup` / `restore` / `reindex-attachments`), produktionsreifes **Helm Chart** und **Kustomize**-Manifeste |

---

## Verzeichnisstruktur

```text
apps/web              Jiange Haupt-Web-Frontend (React + Vite + TS + TanStack Query + Tailwind + shadcn/ui)
server/               Jiange Haupt-Go-Backend: cmd/jiange, internal/{api,auth,backup,blob,btformula,btquery,btsync,config,httpx,migrate,sheetstore,sheetsync,slidessync,store,syncsrv,tableadmission}, collab
packages/
  ooxml               L0: Abhängigkeitsfreies synchrones STORE- + asynchrones DEFLATE-ZIP sowie begrenztes sicheres XML
  collab              L0: Kollaborationskern (RGA/Fugue-CRDT, Offline-Snapshot-Hydrierung & Auto-Merge, Undo, ./table, ./ws, ./storage, ./ai-agent)
  sheet-sdk           L1: Headless AI-Native Tabellen-SDK (inkrementelle AST+DAG-Formel-Engine mit 148 Funktionen, XLSX/CSV, Worker)
  doc-sdk             L1: Headless AI-Native Dokument-SDK (Document Facade, MD/HTML/DOCX, Kommentare & Revisionen)
  slides-sdk          L1: Headless AI-Native Präsentations-SDK (Presentation, PPTX, reines TS-16:9-SVG, Medien & Zuschnitt)
  whiteboard-sdk      L1: Headless AI-Native Whiteboard-/Mindmap-SDK (Board, bidirektionales Mermaid, DAG-Layout, XMind, SVG)
  base-sdk            L1: Abhängigkeitsfreies Headless AI-Native Base-SDK (23 Felder, 7 Ansichten, Formeln, Relationen/Lookup, Dashboards, CSV)
  render-gpu          L2: Null-Canvas-2D-Renderkern (WebGPU/WebGL2 SDF+GlyphAtlas, virtuelle Fenwick-Liste für Millionen Zeilen, SpatialIndex)
  {sheet,doc,slides,whiteboard,base}-ui
                      L2: 5 eigenständige, leichtgewichtige UI-SDKs (natives mount, ./react, <jiange-*> Web Components)
cli/                  Native Go-1.23-CLI ohne externe Abhängigkeiten & Streamable-HTTP/stdio-MCP-Server (einzelne statische Binärdatei ~5,5 MB)
sdk/go/               Einbettbares Go-1.23-Backend-SDK ohne externe Abhängigkeiten (10 Pakete: storage, sync, 5 Domänen-Engines, ai, server, client)
sdk/go-pgstore/       Optionaler PostgreSQL-Adapter für storage.Store (Standard database/sql, kompatibel mit pgx/v5/stdlib und lib/pq)
sdk-docs/             Vollständige SDK-Handbücher, API-Referenz, AI-Native-Protokoll, WebGPU-UI und Go-Integrationsdokumentation
deploy/               Produktionsreifes Kubernetes-Helm-Chart (deploy/helm/jiange), Kustomize-Manifeste (deploy/k8s) und Betriebshandbuch
e2e/                  Automatisierte Playwright-Browser-E2E-Regressionstestsuite (gekoppelt an die GitHub-Actions-CI-Pipeline `e2e`)
benchmarks/           Quantifizierte RFC-§7-Performance-SLAs, Bundle-Größen, Null-Canvas-2D und automatisierte Gates für isolierte Installation aller 13 Pakete
examples/             Ausführbare Beispiele: ts-headless, go-backend, Zero-Build WebGPU/WebGL2 ui-playground
design/               OpenPencil-Design-Quelldateien (jiange.op) und Promo-Video-Projekt (promo/jiange-promo.op + mp4)
spec/                 PROTOCOL.md Kollaborationsprotokoll-Spezifikation + vectors/ sprachübergreifende TS/Go-Konformitätsvektoren
docker-compose.yml    Postgres + MinIO
```

## SDK- und Betriebsdokumentation

- **SDK-Dokumentationsübersicht**: [sdk-docs/README.md](sdk-docs/README.md)
- **5-Minuten-Schnellstart**: [sdk-docs/getting-started.md](sdk-docs/getting-started.md)
- **Handbuch der Headless-TS-SDKs**: [sdk-docs/headless-sdks.md](sdk-docs/headless-sdks.md)
- **Handbuch der WebGPU/WebGL2 + Virtual-List UI-SDKs**: [sdk-docs/gpu-ui-sdks.md](sdk-docs/gpu-ui-sdks.md)
- **AI-Native-Protokoll- und Tool-Spezifikation**: [sdk-docs/ai-native-protocol.md](sdk-docs/ai-native-protocol.md)
- **Go-Backend-SDK, PostgreSQL-Adapter & Go-CLI/MCP**: [sdk-docs/go-backend-and-cli.md](sdk-docs/go-backend-and-cli.md)
- **Performance-Benchmarks, Bundle-Größen & Release-Leitfaden**: [sdk-docs/performance-and-release.md](sdk-docs/performance-and-release.md)
- **Gesamtübersicht & Architekturzusammenfassung**: [headless-sdk.md](headless-sdk.md)
- **Produktions-Deployment, Helm/K8s & Backup/Restore**: [deploy/README.md](deploy/README.md)
- **Playwright-E2E-Testhandbuch**: [e2e/README.md](e2e/README.md)

## Zugelassene Basisbibliotheken

| Schicht | Abhängigkeiten |
|---|---|
| Headless- & GPU-SDKs (`packages/*`) | **Null Drittanbieter-Laufzeitabhängigkeiten** (reines ES2022 TypeScript) |
| Go-SDK & CLI (`sdk/go`, `sdk/go-pgstore`, `cli`) | **Null Drittanbieter-Laufzeitabhängigkeiten** (reine Go-1.23-Standardbibliothek) |
| Web-App (`apps/web`) | `react`, `react-dom`, `@tanstack/react-query`, `tailwindcss`, `shadcn/ui` (sowie `@radix-ui/*`, `class-variance-authority`, `clsx`, `tailwind-merge`) |
| Hauptserver (`server/`) | Go-Standardbibliothek (inkl. reinem Go-SAML 2.0 / LDAP v3 BER / WebAuthn CBOR+COSE / PDF+OOXML-Extraktion / Prometheus), `github.com/jackc/pgx/v5`, `github.com/coder/websocket` |
| Entwicklung & E2E | `vite`, `typescript`, `vitest`, `tsx`, `@playwright/test` |

Kein Einsatz von Yjs, Tiptap, ProseMirror oder schwergewichtigen DI-Containern, Web-Frameworks oder ORMs.

## Lokale Ausführung & Produktionsbetrieb

Voraussetzungen: Node 20+, pnpm 10, Go 1.23+ (`server/` erfordert eine zu `server/go.mod` passende Go-Version), Docker (für Postgres).

```bash
pnpm install
docker compose up -d postgres            # postgres://jiange:jiange@localhost:5432/jiange

cd server && go run ./cmd/jiange         # :8080, führt beim Start die Migrationen (0001..0092) aus
# In einem weiteren Terminal
pnpm --filter @jiange/web dev            # http://localhost:5173 (leitet /api & /scim -> :8080 weiter)
```

Datensicherung, Wiederherstellung und Volltext-Nachindizierung von Anhängen:

```bash
cd server
go run ./cmd/jiange backup /path/to/jiange-backup.tar.gz
go run ./cmd/jiange restore /path/to/jiange-backup.tar.gz
go run ./cmd/jiange reindex-attachments [workspaceId]
```

Zero-Build-Playground für die WebGPU/WebGL2 + Virtual-List UI-SDKs ausprobieren:

```bash
pnpm -r build
node examples/ui-playground/serve.mjs    # http://127.0.0.1:4173
```

Umgebungsvariablen: `DATABASE_URL`, `JIANGE_ADDR` (Standard `:8080`), `JIANGE_SESSION_TTL` (Standard `720h`), `JIANGE_SECURE_COOKIES=true` hinter HTTPS, `JIANGE_SECRET_KEY` (AES-256-GCM-Versiegelung für KI-Schlüssel / SSO-Secrets / Zugangsdaten von LDAP-/WeCom-/DingTalk-Konnektoren / Secrets von Webhooks und Benachrichtigungskanälen), `JIANGE_METRICS_TOKEN` (optionaler Bearer-Token zum Schutz von `/metrics`), `JIANGE_AI_EMBEDDING_MODEL` (optionaler Modellname für Remote-`/embeddings`), `JIANGE_OCR_URL` / `JIANGE_OCR_MODE` / `JIANGE_OCR_API_KEY` / `JIANGE_OCR_TESSERACT` (optionales OCR für Bilder und gescannte PDFs), `JIANGE_BLOB_DIR` (lokales Blob-Verzeichnis auf der Festplatte; überschreibt S3, wenn gesetzt).

Das sichere Stoppen ausstehender Dokumentoperationen ist standardmäßig deaktiviert. Wenden Sie beim Deployment zunächst die Datenbankmigrationen an, aktualisieren und leeren (drain) Sie alle älteren dokumentenschreibenden Instanzen und setzen Sie erst danach `JIANGE_ENABLE_CONDITIONAL_CANCEL=true`. Nach der Aktivierung dürfen keine alten Instanzen ohne Unterstützung für die Stopp-Barriere wieder schreibend aktiv werden. Details siehe [docs/deploy.md](docs/deploy.md) und [deploy/README.md](deploy/README.md).

### Anhänge (MinIO / S3)

Setzen Sie `JIANGE_S3_ENDPOINT` (z. B. `http://localhost:9000`), `JIANGE_S3_ACCESS_KEY`, `JIANGE_S3_SECRET_KEY` sowie optional `JIANGE_S3_BUCKET` (Standard `jiange`; wird beim Start erstellt). Ohne Endpunkt (oder `JIANGE_BLOB_DIR`) sind Uploads deaktiviert. Mit `docker-compose`: `JIANGE_S3_ENDPOINT=http://localhost:9000 JIANGE_S3_ACCESS_KEY=jiange JIANGE_S3_SECRET_KEY=jiange-dev-secret`.

## Tests & Quality Gates

```bash
pnpm lint:names                          # Repository-weite kebab-case-Pfadprüfung (1.960+ getrackte Pfade)
pnpm -r build && pnpm -r typecheck       # Build und Typprüfung aller 13 SDK/UI-Pakete + apps/web
pnpm test                                # Repository-weite Vitest-Unit-Tests (apps/web: 313 Dateien / 1.814 Testfälle)
pnpm test:sdk:coverage                   # 100/100/100/100 V8-Coverage-Gate für alle 13 TS-SDK/UI-Pakete
pnpm test:sdk:pack                       # Echte pnpm-pack-Verifikation in isoliertem Node ESM & NodeNext-Typprüfung
pnpm test:e2e                            # Vollständige Playwright-Browser-E2E-Regression (Login/Workspace/4 Module/Admin/i18n/Offline)
pnpm bench                               # Prüfung aller 7 RFC-§7-Performance-SLAs, Null Canvas 2D & isolierte Installation aller 13 Pakete
pnpm gen:vectors                         # spec/vectors nach Änderungen am Kollaborationskern neu generieren

cd cli && go test -race -cover ./...             # Go-CLI & MCP (4 Pakete, 100,0 % Coverage)
cd sdk/go && go test -race -cover ./...          # Go-Backend-SDK (10 Pakete, 100,0 % Coverage)
cd sdk/go-pgstore && go test -race -cover ./...  # PostgreSQL-Adapter (100,0 % Coverage)
cd server && go test ./... && go vet ./...       # Volltest aller 20 Pakete des Jiange-Hauptservers (inkl. 100 % OpenAPI-Routenkonsistenz & Multi-Replikat-Sync)
JIANGE_TEST_DATABASE_URL=postgres://jiange:jiange@localhost:5432/jiange_test?sslmode=disable go test ./internal/store
go test ./collab -run '^$' -fuzz '^FuzzDecode$' -fuzztime 30s
```

Sprachübergreifende Konsistenz: TypeScript erzeugt `spec/vectors/encoding.json` (Operationen ↔ Hex-Bytes) und `scenarios.json` (Operationen → erwartete materialisierte Ansicht, einschließlich 5 zufälliger 3-Replikat-Sitzungen). Die Go-Tests vergleichen die Kodierung Byte für Byte und spielen jedes Szenario mit 25 zufälligen Reihenfolgevertauschungen und Duplikat-Zustellungen erneut ab; die Ergebnisse müssen exakt mit TypeScript übereinstimmen.

## Authentifizierung, Observability & Open API

Der vollständige Vertrag mit 361 Endpunkten ist direkt unter `GET /api/openapi.json` abrufbar oder lässt sich im Admin-Bereich im Tab „Developer / API“ interaktiv erkunden und als cURL-Befehl kopieren.

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/healthz` · `/readyz` · `/metrics` | Liveness-Probe, DB-/Speicher-Readiness-Probe und Prometheus-0.0.4-Metriken |
| GET | `/api/openapi.json` | Vollständige OpenAPI-3.1.0-Spezifikation (361 Endpunkte, 27 Datenmodelle) |
| GET/POST/PUT/PATCH/DELETE | `/scim/v2/{ServiceProviderConfig,Schemas,ResourceTypes,Users,Groups}` | SCIM-2.0-Synchronisation (RFC 7643/7644) für Organisationsmitglieder und Gruppen (PAT mit `admin`-Scope) |
| POST | `/api/auth/register` · `/api/auth/login` · `/api/auth/mfa/verify` · `/api/auth/password-reset/{request,confirm}` | Registrierung, Passwort-Login (inkl. Ratenbegrenzung, TOTP-/Recovery-Code-Zweifaktorprüfung und verbindlicher MFA-Richtlinie) sowie SMTP-Passwort-Reset |
| POST | `/api/auth/passkey/login/{begin,finish}` | Passwortlose Anmeldung via WebAuthn / Passkeys (FIDO2 ES256/RS256) |
| GET/POST | `/api/auth/sso/{slug}/{start,callback,metadata.xml,acs}` | Enterprise-SSO über OIDC / OAuth2 und SAML 2.0 SP |
| GET/POST/DELETE | `/api/me` · `/api/me/password` · `/api/me/sessions` · `/api/me/passkeys` · `/api/me/tokens` | Aktueller Benutzer, Passwortänderung, Verwaltung/Abmeldung aktiver Gerätesitzungen, Passkeys und PAT-Tokens |
| GET/POST/PATCH/DELETE | `/api/workspaces` · `/api/workspaces/{wsId}` | Multi-Workspace-Erstellung, Wechsel, Umbenennen, Eigentumsübertragung (`/transfer-owner`), Austritt (`/leave`) und Löschen |
| GET/PUT/POST | `/api/workspaces/{wsId}/storage` · `/storage/quota` · `/attachments/reindex` | Speichernutzungs-Dashboard, Kontingentobergrenze (413-Abweisung) und Volltext-/OCR-Nachindizierung bestehender Anhänge |
| POST | `/api/workspaces/{wsId}/org/sync-sources/{sourceId}/pull` | Auslösen eines aktiven Verzeichnis-Pulls für LDAP v3 / WeCom / DingTalk (inkl. Dry-Run) |
| POST | `/api/workspaces/{wsId}/dlp/check` · `/retention/run` | Echtzeit-Test für Enterprise-DLP-Schlüsselwörter/-Regex sowie sofortige Ausführung der Aufbewahrungsbereinigung |
| POST | `/api/ai/ask-workspace` · `/api/ai/workspace-ask/stream` · `/api/ai/doc/stream` | Hybride semantische Vektor-RAG-Abfrage über den gesamten Workspace sowie KI-Schreibassistenz für Einzeldokumente (beide mit zeichenweisem SSE-Streaming) |
| GET/POST | `/api/workspaces/{wsId}/webhooks` · `/notification-channels` | HMAC-SHA256-Webhooks für alle 6 Workspace-Ereigniskategorien und externe Benachrichtigungskanäle (SMTP / Feishu / DingTalk / WeCom / Slack) |

Sitzungen: 32-Byte-Zufallstoken, ausschließlich als SHA-256-Hash gespeichert; Cookie `HttpOnly; SameSite=Lax`. Passwörter: PBKDF2-HMAC-SHA256 (600k Iterationen, Go-Standardbibliothek `crypto/pbkdf2`). Schreibende Anfragen müssen `application/json` verwenden (kombiniert mit `SameSite` als CSRF-Schutz, ausgenommen SAML-HTTP-POST-ACS und Upload-Endpunkte mit benutzerdefinierten Headern).

## Design

Die Benutzeroberfläche wird zunächst in OpenPencil entworfen (`design/jiange.op`), Vorschauen liegen unter `design/previews/`, und die Design-Variablen (`design/vars.json`) werden in `apps/web/src/index.css` auf Tailwind-/shadcn-Theme-Variablen abgebildet. Das Promo-Video wird nativ aus den `.op`-Animationen von OpenPencil v0.8.6 exportiert (`design/promo/jiange-promo.op`).

## Lizenz

Dieses Projekt verwendet ein komponentenbasiertes Lizenzmodell; die vollständigen Bedingungen finden sich in [LICENSE](./LICENSE):

- **Anwendungsteil (`apps/`, `server/` usw.)**: kostenlos für die private und nichtkommerzielle Nutzung; für die kommerzielle Nutzung (einschließlich internem Produktiv- und Geschäftsbetrieb in Unternehmen, Hosting/SaaS, Integration in kommerzielle Produkte oder kostenpflichtige Dienste usw.) ist vorab eine kommerzielle Lizenz zu erwerben.
- **SDK-Teil (`packages/*`, `sdk/*`, `cli/*`)**: kostenlos für private und kommerzielle Zwecke; führen Unternehmen eine Weiterentwicklung der SDKs durch (Änderung, Erweiterung, Kürzung oder Ableitung aus dem Quellcode), müssen sie die Herkunft (basierend auf dem Jiange SDK) an einer öffentlich einsehbaren Stelle wie der Produktdokumentation, einer „Über“-Seite oder der Beschreibung des Quellcode-Repositories deutlich angeben.

---

Dateien und Verzeichnisse verwenden standardmäßig kebab-case, während Code-Bezeichner den Konventionen der jeweiligen Programmiersprache folgen. Go-Plattform- und Testsuffixe, bereits angewandte Datenbank-Migrationsdateinamen, `README.md` / `README.<lang>.md`, `CHANGELOG.md`, `Dockerfile`, `Chart.yaml`, `NOTES.txt`, `_helpers.tpl` sowie Lizenzdateien behalten ihre jeweiligen Tool-Konventionen bei; `pnpm lint:names` prüft die von Git verfolgten Pfade. Die SDKs behalten ältere camelCase-Unterpfade als Kompatibilitätseinstiegspunkte bei; neuer Code sollte kebab-case-Unterpfade verwenden.
