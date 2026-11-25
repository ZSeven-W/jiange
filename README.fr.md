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
  <b>Français</b> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.ru.md">Русский</a>
</p>

<p align="center">
  <strong>Suite collaborative open source complète : Docs + Tableur + Base multidimensionnelle + Présentations + Tableau blanc / Cartes mentales (alternative à Feishu/Lark)</strong><br />
  <sub>IA native · Léger et modulaire · Sécurité et conformité entreprise/secteur public · Haute disponibilité multi-réplicas · Internationalisation bilingue intégrale et CRDT hors ligne · Zéro Canvas 2D (WebGPU/WebGL2 + liste virtuelle)</sub>
</p>

<p align="center">
  Une alternative open source, auto-hébergeable, prête pour l'entreprise et IA native à Feishu/Lark Docs, Sheets, Base, Slides et Whiteboard/MindMap — conçue de zéro avec un moteur CRDT sur mesure, un backend Go pur bibliothèque standard (SAML 2.0, OIDC, SCIM 2.0, LDAP/WeCom/DingTalk, WebAuthn Passkeys, DLP, Prometheus, OpenAPI 3.1), 13 SDK TypeScript/WebGPU sans dépendance et un CLI Go &amp; serveur MCP en binaire unique.
</p>

---

## Vidéo de lancement

<p align="center">
  <a href="design/promo/jiange-promo.mp4">
    <img src="design/promo/jiange-promo-cover.png" alt="Vidéo promotionnelle Jiange — cliquer pour regarder" width="100%" />
  </a>
</p>

<p align="center">
  <sub>
    ▶ <a href="design/promo/jiange-promo.mp4"><b>Regarder la vidéo promotionnelle complète (MP4 · 30s · bande-son originale incluse)</b></a><br />
    Animations produites et exportées depuis un projet natif <code>.op</code> dans <b>OpenPencil v0.8.6</b> (<a href="design/promo/jiange-promo.op"><code>design/promo/jiange-promo.op</code></a> / <a href="design/promo/build-jiange-promo.py">script de génération</a>) ; musique instrumentale générée localement par le modèle <b>MiniMax H3-Music</b>.
  </sub>
</p>

---

## Fonctionnalités clés de la suite

| Module | Capacités clés |
|---|---|
| **Documents cloud (Doc)** | Collaboration temps réel sur moteur CRDT RGA/Fugue maison, **édition collaborative CRDT hors ligne avancée avec fusion automatique à la reconnexion** (persistance des réplicas dans IndexedDB), 15+ types de blocs (dont `audio` / `video` natifs, `poll` sondages temps réel, `countdown` comptes à rebours, `tabs` onglets, tableaux, blocs de code, formules, Mermaid, blocs synchronisés, multi-colonnes, tableaux intégrés), **suivi des modifications en ligne (Track Changes)**, commentaires sur sélection et réactions emoji, lecture suivie, historique des versions, import/export DOCX / Markdown (avec images) et impression PDF |
| **Tableur (Sheet)** | Grille virtuelle WebGPU/WebGL2 à l'échelle du million de lignes, **148 fonctions de formules intégrées** (dont `XLOOKUP` / `FILTER` / `SORT` / `UNIQUE` / `LET` / `LAMBDA` / `ARRAYFORMULA` / `QUERY` / `REGEX*` / `IMAGE`), graphiques flottants, tableaux croisés dynamiques, **graphiques sparkline SVG intégrés aux cellules**, regroupement pliable de lignes/colonnes, images dans les cellules, mise en forme conditionnelle / validation des données / plages protégées, plages nommées cloud, historique des versions et journal de modification par cellule, fusion incrémentale des cellules hors ligne, import/export XLSX/CSV, **assistant IA de formules** |
| **Base multidimensionnelle (Base)** | Tables multiples et relations bidirectionnelles inter-tables, **23 types de champs** (dont devise, progression, numérotation automatique, bouton d'action, géolocalisation, formule, relation, recherche/lookup), **7 types de vues** (Grille, Kanban, Gantt avec liens de dépendance, Calendrier, Galerie, **vue arborescente hiérarchique**, formulaires publics à branchement conditionnel), regroupement imbriqué jusqu'à 3 niveaux, workflows d'automatisation multi-étapes, tableaux de bord de données, RBAC multi-rôles granulaire par ligne et par colonne, import/export XLSX/CSV, **remplissage IA par lot sur une colonne** |
| **Présentations (Slides)** | Canevas WebGPU/WebGL2, **masques de diapositives et kit de marque (Master Brand Kit)**, formes texte/graphique/tableau/diagramme/vidéo/audio, recadrage d'images, animations élément par élément et transitions entre diapositives, mode présentateur (pointeur laser / annotations au stylet + **suivi de présentation en temps réel par l'audience** via WebSocket), commentaires par diapositive ou élément, historique des versions, fusion hors ligne des brouillons de diapositives, import/export PPTX et impression PDF |
| **Tableau blanc et cartes mentales** | Canevas infini, organigrammes et couloirs (swimlanes), post-its de brainstorming / surligneur / vote par points / minuteur / minicarte / cadres de regroupement, cartes mentales multi-structures, encadrés / résumés / badges, synchronisation bidirectionnelle avec le plan, export Mermaid / XMind / SVG / PNG |
| **Base de connaissances, Drive et recherche plein texte** | **Cycle de vie complet multi-espaces de travail** (création, bascule en un clic, renommage, transfert de propriété UI/API, départ d'un membre, suppression), espaces de connaissances indépendants et arborescences multiniveaux, raccourcis, **déplacement inter-espaces (personnel / partagé / inter-espaces de travail)**, **tableau de bord d'utilisation du stockage et contrôle de quota (HTTP 413)**, **prévisualisation en ligne tous formats** (zoom/rotation d'images, PDF, audio/vidéo, code/Markdown/CSV, `.docx`/`.xlsx`/`.pptx`, y compris aperçu enrichi des pièces jointes dans les documents publics en lecture seule), **extraction plein texte pure Go des pièces jointes + OCR enfichable (HTTP / OpenAI Vision / `tesseract`) + réindexation rétroactive en un clic ou via CLI des pièces jointes existantes** |
| **Espace de travail IA natif** | **Questions-réponses RAG hybrides (vecteurs sémantiques + BM25) sur toute la base de connaissances** (vecteurs locaux 128 dimensions + `/embeddings` distant optionnel + isolation des permissions + citations des sources pour les documents et pièces jointes PDF/Office/OCR), **streaming SSE mot à mot double canal à l'échelle de l'espace et par document** (`POST /api/ai/workspace-ask/stream` · `POST /api/ai/doc/stream`), génération IA de formules de tableur, remplissage IA par lot dans Base, intégration multimodèle compatible OpenAI / Anthropic (repli automatique sur le moteur local en l'absence de clé API) |
| **Identité d'entreprise et synchronisation d'annuaire (IAM)** | **OIDC / OAuth2 + SAML 2.0 SP** (Metadata XML, AuthnRequest, vérification native XML-DSig RSA/ECDSA et protection XXE/XSW), **SCIM 2.0 (implémentation RFC 7644 complète)** (`ServiceProviderConfig`, `Schemas`, `ResourceTypes`, `Users`/`Groups` complets avec `PUT`/`PATCH`/`DELETE`/filtrage/pagination), **pull actif et synchronisation planifiée LDAP v3 / WeCom / DingTalk** (client ASN.1 BER natif + identifiants chiffrés), **MFA TOTP + 8 codes de récupération + politique MFA obligatoire par espace avec bannière globale en haut de page**, **connexion sans mot de passe WebAuthn / Passkeys (FIDO2 ES256/RS256)**, **boucle complète de sécurité de compte en libre-service** (limitation anti-force brute sur connexion/MFA/Passkey/liens publics, changement de mot de passe, réinitialisation par SMTP, liste des appareils connectés et révocation à distance) |
| **Sécurité, conformité et écosystème ouvert** | **DLP d'entreprise par mots-clés sensibles et regex RE2 sûres** (couvrant Doc / Sheet / Base / Slides / Survey, blocage ou alerte sur le partage public et les exports CSV/pièces jointes publiques), **politiques de rétention des données avec purge planifiée en arrière-plan ou manuelle**, filigranes anti-fuite sur toute la suite, mots de passe sur les liens de partage public, journaux d'audit de sécurité d'entreprise avec export CSV, **contrat OpenAPI 3.1.0 intégral (361 points de terminaison vérifiés à 100 % sur les routes + 27 modèles de données + portail développeur interactif)**, **jetons d'accès personnels (PAT)**, **webhooks HMAC-SHA256 sur les 6 catégories d'événements d'espace**, **canaux de notification externes** (SMTP / Feishu / DingTalk / WeCom / Slack) |
| **Haute disponibilité, internationalisation et Cloud-Native** | **Mise à l'échelle horizontale multi-réplicas sur les 4 hubs de collaboration temps réel** (Doc `syncsrv` / Base `btsync` / Sheet `sheetsync` / Slides `slidessync`, tous diffusés entre nœuds via Postgres `LISTEN/NOTIFY`), **internationalisation complète chinois/anglais sur tout le dépôt** (5 355 entrées, 0 oubli visible côté utilisateur), **`React.lazy` au niveau des routes + découpage de bundles Rollup** (bundle principal 308 KB / gzip 84 KB), édition hors ligne PWA + IndexedDB avec fusion automatique à la reconnexion (Doc / Base / Sheet / Slides), `/healthz` + `/readyz` + Prometheus `/metrics` + W3C `traceparent`, CLI de sauvegarde/restauration complète vérifiée par SHA-256 (`jiange backup` / `restore` / `reindex-attachments`), **Helm Chart** et manifestes **Kustomize** prêts pour la production |

---

## Démarrage rapide

Vous pouvez intégrer Jiange selon vos besoins de quatre façons : **suite complète auto-hébergée**, **SDK TypeScript/WebGPU npm**, **SDK backend Go embarquable** ou **CLI Go / serveur MCP IA** :

### 1. Lancer la suite collaborative complète en une commande (Docker)

```bash
# Option A : démarrage en une commande avec Docker Compose (Postgres 16 + MinIO + suite complète Jiange)
git clone https://github.com/ZSeven-W/jiange.git && cd jiange
docker compose up -d --build
# Ouvrez http://localhost:8080 et inscrivez le premier administrateur d'espace de travail pour commencer

# Option B : tirer directement l'image multi-architecture précompilée depuis GHCR (linux/amd64 & linux/arm64)
docker pull ghcr.io/zseven-w/jiange:latest
docker run -d --name jiange -p 8080:8080 \
  -e DATABASE_URL="postgres://jiange:jiange@host.docker.internal:5432/jiange?sslmode=disable" \
  -e JIANGE_SECURE_COOKIES="false" \
  -e JIANGE_SECRET_KEY="$(openssl rand -hex 32)" \
  -v jiange_blobs:/data/blobs \
  ghcr.io/zseven-w/jiange:latest
```

> Pour un déploiement Kubernetes en production, utilisez directement le Helm Chart (`helm upgrade --install jiange ./deploy/helm/jiange`) ; voir [deploy/README.md](deploy/README.md) pour plus de détails.

### 2. Utiliser les SDK TypeScript / WebGPU (npm `@zseven-w/*`)

Les **13 paquets sans dépendance tierce** sont tous publiés sur npmjs.com (`0.2.0`) et peuvent être installés indépendamment par module :

```bash
# Installer les moteurs Headless à la demande (compatibles Node.js / navigateur / Edge / agents IA)
npm install @zseven-w/sheet-sdk        # Tableur (148 formules + XLSX/CSV + outils IA)
npm install @zseven-w/doc-sdk          # Documents cloud (CRDT + MD/HTML/DOCX + commentaires et révisions)
npm install @zseven-w/base-sdk         # Base multidimensionnelle (23 champs + 7 vues + formules et relations)
npm install @zseven-w/slides-sdk       # Présentations (PPTX + SVG 16:9 pur TS)
npm install @zseven-w/whiteboard-sdk   # Tableau blanc et cartes mentales (Mermaid + mise en page DAG + XMind)

# Optionnel : installer les composants UI WebGPU/WebGL2 + liste virtuelle (zéro Canvas 2D, avec mount natif / React / Web Components)
npm install @zseven-w/sheet-ui @zseven-w/doc-ui @zseven-w/base-ui @zseven-w/slides-ui @zseven-w/whiteboard-ui
```

Exemple de calcul de formules Headless + simulation d'outils IA (`dryRun`) + export `.xlsx` :

```ts
import { Workbook, createSheetTools } from "@zseven-w/sheet-sdk";

const wb = Workbook.fromCsv("Product,Units,UnitPrice\nPro,120,49\nEnterprise,25,299\n", "Q4");
const tools = createSheetTools(wb);

// L'agent IA vérifie d'abord via dryRun avant d'appliquer, avec recalcul incrémental automatique des formules
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
const xlsxBytes = await wb.toXlsxAsync();   // Flux d'octets .xlsx DEFLATE standard
```

Monter la grille virtuelle WebGPU/WebGL2 dans le navigateur (DOM natif / React / `<jiange-sheet>`) :

```ts
import { mountSheetView } from "@zseven-w/sheet-ui";

const view = await mountSheetView(document.getElementById("sheet-root")!, wb);
// Appelez view.dispose() lors du démontage
```

### 3. Embarquer le SDK backend dans un service Go (`sdk/go` & `sdk/go-pgstore`)

```bash
go get github.com/ZSeven-W/jiange/sdk/go@v0.2.0
go get github.com/ZSeven-W/jiange/sdk/go-pgstore@v0.2.0   # Adaptateur de persistance PostgreSQL optionnel
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
		Store:   storage.NewMemoryStore(), // Remplacez par pgstore.New(db) en production
		Auth:    storage.NewBearerTokenAuth(map[string]storage.Principal{"my-token": {ID: "u-1", Name: "Admin", Roles: []string{"admin"}}}),
		Version: "0.2.0",
	})
	mux := http.NewServeMux()
	mux.Handle("/api/v1/", http.StripPrefix("/api/v1", app))
	_ = http.ListenAndServe(":8090", mux)
}
```

### 4. Utiliser le CLI Go et le serveur MCP pour agents IA (`jiange`)

```bash
# Installer via Go Module (ou télécharger les binaires statiques précompilés pour 5 plateformes depuis GitHub Releases)
go install github.com/ZSeven-W/jiange/cli/cmd/jiange@v0.2.0

# Lire et modifier des fichiers bureautiques directement en local (zéro dépendance Node.js)
jiange sheet inspect budget.xlsx --detail full
jiange sheet patch budget.xlsx --ops '[{"op":"setCell","sheet":"Sheet1","a1":"B2","raw":"=SUM(A1:A10)"}]' --out out.xlsx
jiange doc convert spec.md --out spec.docx
jiange slides render deck.pptx --slide 0 --out slide1.svg
jiange board render arch.mmd --out arch.svg

# Démarrer le serveur MCP (prend en charge stdio ou Streamable HTTP)
jiange mcp --transport stdio
jiange mcp --transport http --addr 127.0.0.1:8787
```

Configurez-le directement dans des clients MCP tels que **Claude Desktop / Cursor / Antigravity** :

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

> Les binaires CLI précompilés (Linux / macOS / Windows `amd64` & `arm64`) et toutes les archives hors ligne des SDK sont disponibles dans [GitHub Releases (`sdk-v0.2.0`)](https://github.com/ZSeven-W/jiange/releases/tag/sdk-v0.2.0) ; la référence API complète figure dans [sdk-docs/getting-started.md](sdk-docs/getting-started.md).

---

## Structure du dépôt

```text
apps/web              Frontend Web principal de Jiange (React + Vite + TS + TanStack Query + Tailwind + shadcn/ui)
server/               Backend Go principal de Jiange : cmd/jiange, internal/{api,auth,backup,blob,btformula,btquery,btsync,config,httpx,migrate,sheetstore,sheetsync,slidessync,store,syncsrv,tableadmission}, collab
packages/
  ooxml               L0 : ZIP synchrone STORE + DEFLATE asynchrone sans dépendance et XML borné sécurisé
  collab              L0 : Noyau collaboratif (CRDT RGA/Fugue, hydratation de snapshots hors ligne et fusion auto, Undo, ./table, ./ws, ./storage, ./ai-agent)
  sheet-sdk           L1 : SDK tableur headless IA-Native (moteur de formules incrémental AST+DAG 148 fonctions, XLSX/CSV, Worker)
  doc-sdk             L1 : SDK document headless IA-Native (Document Facade, MD/HTML/DOCX, commentaires et révisions)
  slides-sdk          L1 : SDK présentation headless IA-Native (Presentation, PPTX, SVG 16:9 pur TS, médias et recadrage)
  whiteboard-sdk      L1 : SDK tableau blanc/carte mentale headless IA-Native (Board, Mermaid bidirectionnel, mise en page DAG, XMind, SVG)
  base-sdk            L1 : SDK base multidimensionnelle headless IA-Native sans dépendance (23 champs, 7 vues, formules, relations/lookup, tableaux de bord, CSV)
  render-gpu          L2 : Noyau de rendu zéro Canvas 2D (WebGPU/WebGL2 SDF+GlyphAtlas, liste virtuelle Fenwick au million de lignes, SpatialIndex)
  {sheet,doc,slides,whiteboard,base}-ui
                      L2 : 5 SDK UI autonomes et légers (mount natif, ./react, Web Components <jiange-*>)
cli/                  CLI natif Go 1.23 sans dépendance externe & serveur MCP Streamable HTTP/stdio (binaire statique unique ~5,5 MB)
sdk/go/               SDK backend embarquable Go 1.23 sans dépendance externe (10 paquets : storage, sync, 5 moteurs métier, ai, server, client)
sdk/go-pgstore/       Adaptateur PostgreSQL storage.Store optionnel (database/sql standard, compatible pgx/v5/stdlib et lib/pq)
sdk-docs/             Guides SDK complets, référence API, protocole IA-Native, UI WebGPU et documentation d'intégration Go
deploy/               Helm Chart Kubernetes de production (deploy/helm/jiange), manifestes Kustomize (deploy/k8s) et guide d'exploitation
e2e/                  Suite de tests de régression end-to-end navigateur Playwright (reliée au pipeline CI `e2e` GitHub Actions)
benchmarks/           SLA de performance quantifiés RFC §7, taille des bundles, zéro Canvas 2D et portes automatisées d'installation isolée des 13 paquets
examples/             Exemples exécutables : ts-headless, go-backend, ui-playground WebGPU/WebGL2 sans build
design/               Sources de design OpenPencil (jiange.op) et projet vidéo promotionnelle (promo/jiange-promo.op + mp4)
spec/                 Spécification du protocole collaboratif PROTOCOL.md + vectors/ vecteurs de conformité inter-langages TS/Go
docker-compose.yml    Postgres + MinIO
```

## Documentation SDK et exploitation

- **Accueil de la documentation SDK** : [sdk-docs/README.md](sdk-docs/README.md)
- **Démarrage rapide en 5 minutes** : [sdk-docs/getting-started.md](sdk-docs/getting-started.md)
- **Guide des SDK TypeScript Headless** : [sdk-docs/headless-sdks.md](sdk-docs/headless-sdks.md)
- **Guide des SDK UI WebGPU/WebGL2 + liste virtuelle** : [sdk-docs/gpu-ui-sdks.md](sdk-docs/gpu-ui-sdks.md)
- **Spécification du protocole et des outils IA-Native** : [sdk-docs/ai-native-protocol.md](sdk-docs/ai-native-protocol.md)
- **SDK backend Go, adaptateur PostgreSQL et CLI/MCP Go** : [sdk-docs/go-backend-and-cli.md](sdk-docs/go-backend-and-cli.md)
- **Benchmarks de performance, tailles de bundles et guide de publication** : [sdk-docs/performance-and-release.md](sdk-docs/performance-and-release.md)
- **Vue d'ensemble et résumé d'architecture** : [headless-sdk.md](headless-sdk.md)
- **Déploiement en production, Helm/K8s et sauvegarde/restauration** : [deploy/README.md](deploy/README.md)
- **Manuel des tests E2E Playwright** : [e2e/README.md](e2e/README.md)

## Bibliothèques fondamentales autorisées

| Couche | Dépendances |
|---|---|
| SDK Headless & GPU (`packages/*`) | **Zéro dépendance d'exécution tierce** (TypeScript ES2022 pur) |
| SDK Go & CLI (`sdk/go`, `sdk/go-pgstore`, `cli`) | **Zéro dépendance d'exécution tierce** (bibliothèque standard Go 1.23 pure) |
| Application Web (`apps/web`) | `react`, `react-dom`, `@tanstack/react-query`, `tailwindcss`, `shadcn/ui` (ainsi que `@radix-ui/*`, `class-variance-authority`, `clsx`, `tailwind-merge`) |
| Serveur principal (`server/`) | Bibliothèque standard Go (incluant SAML 2.0 / LDAP v3 BER / WebAuthn CBOR+COSE / extraction PDF+OOXML / Prometheus en pur Go), `github.com/jackc/pgx/v5`, `github.com/coder/websocket` |
| Développement & E2E | `vite`, `typescript`, `vitest`, `tsx`, `@playwright/test` |

N'utilise ni Yjs, ni Tiptap, ni ProseMirror, ni aucun conteneur d'injection de dépendances lourd, framework Web ou ORM.

## Exécution locale et exploitation en production

Prérequis : Node 20+, pnpm 10, Go 1.23+ (`server/` requiert la version de Go définie dans `server/go.mod`), Docker (pour Postgres).

```bash
pnpm install
docker compose up -d postgres            # postgres://jiange:jiange@localhost:5432/jiange

cd server && go run ./cmd/jiange         # :8080, exécute les migrations (0001..0092) au démarrage
# Dans un autre terminal
pnpm --filter @jiange/web dev            # http://localhost:5173 (proxy /api & /scim -> :8080)
```

Sauvegarde, restauration des données et réindexation plein texte des pièces jointes :

```bash
cd server
go run ./cmd/jiange backup /path/to/jiange-backup.tar.gz
go run ./cmd/jiange restore /path/to/jiange-backup.tar.gz
go run ./cmd/jiange reindex-attachments [workspaceId]
```

Essayer le playground sans build des SDK UI WebGPU/WebGL2 + liste virtuelle :

```bash
pnpm -r build
node examples/ui-playground/serve.mjs    # http://127.0.0.1:4173
```

Variables d'environnement : `DATABASE_URL`, `JIANGE_ADDR` (`:8080` par défaut), `JIANGE_SESSION_TTL` (`720h` par défaut), `JIANGE_SECURE_COOKIES=true` derrière HTTPS, `JIANGE_SECRET_KEY` (scellement AES-256-GCM pour les clés IA / secrets SSO / identifiants des connecteurs LDAP-WeCom-DingTalk / secrets des webhooks et canaux de notification), `JIANGE_METRICS_TOKEN` (jeton Bearer optionnel protégeant `/metrics`), `JIANGE_AI_EMBEDDING_MODEL` (nom de modèle optionnel pour `/embeddings` distant), `JIANGE_OCR_URL` / `JIANGE_OCR_MODE` / `JIANGE_OCR_API_KEY` / `JIANGE_OCR_TESSERACT` (OCR optionnel pour les images et PDF numérisés), `JIANGE_BLOB_DIR` (répertoire local sur disque pour les blobs ; prime sur S3 lorsqu'il est défini).

L'arrêt sécurisé des opérations de document en attente de confirmation est désactivé par défaut. Lors du déploiement, appliquez d'abord les migrations de base de données, mettez à niveau et drainez toutes les anciennes instances d'écriture documentaire, puis activez `JIANGE_ENABLE_CONDITIONAL_CANCEL=true` ; une fois activé, aucune ancienne instance ne prenant pas en charge la barrière d'arrêt ne doit recommencer à écrire. Voir [docs/deploy.md](docs/deploy.md) et [deploy/README.md](deploy/README.md).

### Pièces jointes (MinIO / S3)

Définissez `JIANGE_S3_ENDPOINT` (par ex. `http://localhost:9000`), `JIANGE_S3_ACCESS_KEY`, `JIANGE_S3_SECRET_KEY` et éventuellement `JIANGE_S3_BUCKET` (`jiange` par défaut ; créé au démarrage). Sans point de terminaison S3 (ni `JIANGE_BLOB_DIR`), les téléversements sont désactivés. Avec `docker-compose` : `JIANGE_S3_ENDPOINT=http://localhost:9000 JIANGE_S3_ACCESS_KEY=jiange JIANGE_S3_SECRET_KEY=jiange-dev-secret`.

## Tests et portes qualité

```bash
pnpm lint:names                          # Vérification kebab-case sur tout le dépôt (1 960+ chemins suivis)
pnpm -r build && pnpm -r typecheck       # Build et vérification de types des 13 paquets SDK/UI + apps/web
pnpm test                                # Tests unitaires Vitest sur tout le dépôt (apps/web : 313 fichiers / 1 814 cas de test)
pnpm test:sdk:coverage                   # Porte de couverture V8 100/100/100/100 sur les 13 paquets SDK/UI TS
pnpm test:sdk:pack                       # Validation réelle via pnpm pack en isolation Node ESM et typage NodeNext
pnpm test:e2e                            # Régression navigateur E2E complète Playwright (connexion / espace / 4 modules / admin / bilingue / hors ligne)
pnpm bench                               # Vérification des 7 SLA de performance RFC §7, zéro Canvas 2D et installation isolée des 13 paquets
pnpm gen:vectors                         # Régénération de spec/vectors après modification du noyau collaboratif

cd cli && go test -race -cover ./...             # CLI & MCP Go (4 paquets, 100,0 % de couverture)
cd sdk/go && go test -race -cover ./...          # SDK backend Go (10 paquets, 100,0 % de couverture)
cd sdk/go-pgstore && go test -race -cover ./...  # Adaptateur PostgreSQL (100,0 % de couverture)
cd server && go test ./... && go vet ./...       # Suite complète des 20 paquets du serveur Jiange (dont cohérence 100 % des routes OpenAPI et synchro multi-réplicas)
JIANGE_TEST_DATABASE_URL=postgres://jiange:jiange@localhost:5432/jiange_test?sslmode=disable go test ./internal/store
go test ./collab -run '^$' -fuzz '^FuzzDecode$' -fuzztime 30s
```

Conformité inter-langages : TypeScript génère `spec/vectors/encoding.json` (opérations ↔ octets hexadécimaux) et `scenarios.json` (opérations → vue matérialisée attendue, dont 5 sessions aléatoires à 3 réplicas). Les tests Go comparent l'encodage octet par octet et rejouent chaque scénario selon 25 permutations aléatoires avec désordonnancement et livraisons dupliquées ; les résultats doivent correspondre exactement à ceux de TypeScript.

## Authentification, observabilité et API ouverte

Le contrat complet des 361 points de terminaison est accessible directement via `GET /api/openapi.json` ou consultable de manière interactive avec commandes cURL prêtes à copier dans l'onglet « Développeur / API » de la console d'administration.

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/healthz` · `/readyz` · `/metrics` | Sonde de vivacité, sonde de disponibilité BDD/stockage et métriques Prometheus 0.0.4 |
| GET | `/api/openapi.json` | Spécification OpenAPI 3.1.0 complète (361 points de terminaison, 27 modèles de données) |
| GET/POST/PUT/PATCH/DELETE | `/scim/v2/{ServiceProviderConfig,Schemas,ResourceTypes,Users,Groups}` | Synchronisation SCIM 2.0 (RFC 7643/7644) des membres et groupes d'organisation (PAT avec portée `admin`) |
| POST | `/api/auth/register` · `/api/auth/login` · `/api/auth/mfa/verify` · `/api/auth/password-reset/{request,confirm}` | Inscription, connexion par mot de passe (avec limitation de débit, défi en deux étapes TOTP/codes de récupération et politique MFA obligatoire) et réinitialisation SMTP |
| POST | `/api/auth/passkey/login/{begin,finish}` | Connexion sans mot de passe WebAuthn / Passkeys (FIDO2 ES256/RS256) |
| GET/POST | `/api/auth/sso/{slug}/{start,callback,metadata.xml,acs}` | Authentification unique (SSO) d'entreprise OIDC / OAuth2 et SAML 2.0 SP |
| GET/POST/DELETE | `/api/me` · `/api/me/password` · `/api/me/sessions` · `/api/me/passkeys` · `/api/me/tokens` | Utilisateur courant, changement de mot de passe, gestion/révocation des sessions d'appareils actifs, clés d'accès (Passkeys) et jetons PAT |
| GET/POST/PATCH/DELETE | `/api/workspaces` · `/api/workspaces/{wsId}` | Création multi-espaces de travail, bascule, renommage, transfert de propriété (`/transfer-owner`), départ (`/leave`) et suppression |
| GET/PUT/POST | `/api/workspaces/{wsId}/storage` · `/storage/quota` · `/attachments/reindex` | Tableau de bord d'utilisation du stockage, plafond de quota (rejet HTTP 413) et réindexation plein texte/OCR des pièces jointes existantes |
| POST | `/api/workspaces/{wsId}/org/sync-sources/{sourceId}/pull` | Déclenchement d'une synchronisation active d'annuaire LDAP v3 / WeCom / DingTalk (avec prise en charge Dry-Run) |
| POST | `/api/workspaces/{wsId}/dlp/check` · `/retention/run` | Test en temps réel des mots-clés/regex DLP d'entreprise et exécution immédiate de la purge selon la politique de rétention |
| POST | `/api/ai/ask-workspace` · `/api/ai/workspace-ask/stream` · `/api/ai/doc/stream` | Questions-réponses RAG vectoriel hybride sur tout l'espace et rédaction IA sur document unique (tous deux avec streaming SSE mot à mot) |
| GET/POST | `/api/workspaces/{wsId}/webhooks` · `/notification-channels` | Webhooks HMAC-SHA256 pour les 6 catégories d'événements d'espace et canaux de notification externes (SMTP / Feishu / DingTalk / WeCom / Slack) |

Sessions : jeton aléatoire de 32 octets, stocké uniquement sous forme de hachage SHA-256 ; cookie `HttpOnly; SameSite=Lax`. Mots de passe : PBKDF2-HMAC-SHA256 (600k itérations, bibliothèque standard Go `crypto/pbkdf2`). Les requêtes d'écriture doivent utiliser `application/json` (combiné à `SameSite` contre le CSRF, à l'exception de l'endpoint ACS SAML HTTP-POST et des points de téléversement munis d'en-têtes personnalisés).

## Design

L'interface utilisateur est d'abord conçue dans OpenPencil (`design/jiange.op`), avec aperçus dans `design/previews/` ; les variables de design (`design/vars.json`) sont mappées vers les variables de thème Tailwind/shadcn dans `apps/web/src/index.css`. La vidéo de lancement est exportée nativement depuis les animations `.op` d'OpenPencil v0.8.6 (`design/promo/jiange-promo.op`).

## Licence

Ce projet est distribué sous licence par composant ; les conditions complètes figurent dans [LICENSE](./LICENSE) :

- **Partie application (`apps/`, `server/`, etc.)** : gratuite pour un usage personnel et non commercial ; tout usage commercial (y compris l'exploitation interne en production d'entreprise, l'hébergement/SaaS, l'intégration dans un produit commercial ou un service payant, etc.) nécessite l'acquisition préalable d'une licence commerciale.
- **Partie SDK (`packages/*`, `sdk/*`, `cli/*`)** : gratuite pour tous les usages, personnels comme commerciaux ; si une entreprise effectue des développements secondaires sur les SDK (modification, extension, découpage ou œuvre dérivée du code source), elle doit indiquer clairement la source (basé sur Jiange SDK) dans un emplacement public tel que la documentation produit, la page « À propos » ou la description du dépôt source.

---

Les fichiers et répertoires suivent par défaut la convention kebab-case, tandis que les identifiants de code respectent les usages de chaque langage. Les suffixes de plateforme et de test Go, les noms de fichiers de migration de base de données déjà appliqués, `README.md` / `README.<lang>.md`, `CHANGELOG.md`, `Dockerfile`, `Chart.yaml`, `NOTES.txt`, `_helpers.tpl` et les fichiers de licence conservent les conventions de leurs outils ; `pnpm lint:names` vérifie les chemins suivis par Git. Les SDK conservent les anciens sous-chemins camelCase pour compatibilité ; tout nouveau code doit utiliser les sous-chemins kebab-case.
