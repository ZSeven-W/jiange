# Jiange

<p align="center">
  <img src="apps/web/public/brand/jiange-lockup.svg" width="240" alt="Jiange" />
</p>

<p align="center">
  <a href="README.md">简体中文</a> ·
  <a href="README.en.md">English</a> ·
  <a href="README.zh-TW.md">繁體中文</a> ·
  <b>日本語</b> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.ru.md">Русский</a>
</p>

<p align="center">
  <a href="https://github.com/ZSeven-W/jiange/actions/workflows/ci.yml"><img src="https://github.com/ZSeven-W/jiange/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/ZSeven-W/jiange/releases/latest"><img src="https://img.shields.io/github/v/release/ZSeven-W/jiange?label=release&color=3370FF" alt="Latest Release" /></a>
  <a href="https://www.npmjs.com/package/@zseven-w/sheet-sdk"><img src="https://img.shields.io/npm/v/%40zseven-w%2Fsheet-sdk?label=npm%20%40zseven-w%2F*&color=CB3837" alt="npm SDKs" /></a>
  <a href="https://github.com/ZSeven-W/jiange/pkgs/container/jiange"><img src="https://img.shields.io/badge/ghcr.io-zseven--w%2Fjiange-2496ED?logo=docker&logoColor=white" alt="GHCR Docker Image" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Dual--Track%20%7C%20SDK%20Free-10B981" alt="License" /></a>
</p>

<p align="center">
  <strong>オープンソースの Feishu / Lark 互換コラボレーションスイート（ドキュメント + スプレッドシート + 多次元テーブル + スライド + ホワイトボード・マインドマップ）</strong><br />
  <sub>AI ネイティブ · 軽量＆モジュール分割可能 · エンタープライズ向けセキュリティ・コンプライアンス · マルチレプリカ高可用性 · リポジトリ全体のバイリンガル対応＆オフライン CRDT · ゼロ Canvas 2D（WebGPU/WebGL2 + 仮想リスト）</sub>
</p>

<p align="center">
  Feishu / Lark の Docs、Sheets、Base、Slides、Whiteboard / MindMap に代わる、オープンソース・セルフホスト可能・エンタープライズ対応の AI ネイティブ協業プラットフォームです。独自開発の CRDT エンジン、Go 標準ライブラリ中心のバックエンド（SAML 2.0、OIDC、SCIM 2.0、LDAP / WeCom / DingTalk、WebAuthn Passkeys、DLP、Prometheus、OpenAPI 3.1）、ゼロ依存の 13 個の TypeScript / WebGPU SDK、および単一バイナリの Go CLI &amp; MCP Server をゼロから構築しています。
</p>

---

## プロモーション動画

<p align="center">
  <a href="design/promo/jiange-promo.mp4">
    <img src="design/promo/jiange-promo-cover.png" alt="Jiange プロモーション動画 — クリックして再生" width="100%" />
  </a>
</p>

<p align="center">
  <sub>
    ▶ <a href="design/promo/jiange-promo.mp4"><b>フルプロモーション動画を視聴（MP4 · 30s · オリジナル BGM 付き）</b></a><br />
    モーション映像は <b>OpenPencil v0.8.6</b> のネイティブ <code>.op</code> プロジェクトで制作・書き出し（<a href="design/promo/jiange-promo.op"><code>design/promo/jiange-promo.op</code></a> / <a href="design/promo/build-jiange-promo.py">生成スクリプト</a>）、BGM はローカルの <b>MiniMax H3-Music</b> 器楽モデルで生成しています。
  </sub>
</p>

---

## 主な製品機能

| モジュール | 主な機能 |
|---|---|
| **クラウドドキュメント** | 独自開発の RGA/Fugue CRDT によるリアルタイム共同編集、**完全なオフライン CRDT 共同編集と再接続時の自動マージ**（IndexedDB によるローカルレプリカ永続化）、15+ 種類のブロック（ネイティブの `audio` / `video` / `poll` リアルタイム投票 / `countdown` カウントダウン / `tabs` タブ / テーブル / コードブロック / 数式 / Mermaid / 同期ブロック / マルチカラム / 埋め込みテーブル）、**インライン変更履歴モード（Track Changes）**、テキスト選択コメントとリアクション絵文字、閲覧フォロー、バージョン履歴、DOCX / Markdown（画像含む）インポート・エクスポート、PDF 印刷 |
| **スプレッドシート** | WebGPU/WebGL2 ベースの 100 万行対応仮想グリッド、**148 個の組み込み数式関数**（`XLOOKUP` / `FILTER` / `SORT` / `UNIQUE` / `LET` / `LAMBDA` / `ARRAYFORMULA` / `QUERY` / `REGEX*` / `IMAGE` を含む）、フローティングチャート、ピボットテーブル、**セル内 SVG スパークライン（Sparklines）**、行・列の折りたたみグループ化、セル内画像、条件付き書式・データ入力規則・保護範囲、クラウド名前付き範囲、バージョン履歴とセル変更ログ、オフラインセル差分マージ、XLSX / CSV インポート・エクスポート、**AI 数式アシスタント** |
| **多次元テーブル（Base）** | マルチテーブルとテーブル間の双方向リレーション、**23 種類のフィールド型**（通貨、進捗、自動採番、アクションボタン、位置情報、数式、リレーション、ルックアップ等）、**7 種類のビュー**（グリッド、カンバン、依存線付きガントチャート、カレンダー、ギャラリー、**階層ツリービュー**、条件分岐付き公開フォーム）、最大 3 階層のネストグループ化、マルチステップ自動化ワークフロー、データダッシュボード、マルチロール対応のきめ細かな行・列単位 RBAC、XLSX / CSV インポート・エクスポート、**AI による列一括入力** |
| **スライド** | WebGPU/WebGL2 キャンバス、**マスタースライドとブランドキット（Master Brand Kit）**、テキスト・図形・テーブル・チャート・動画・音声シェイプ、画像トリミング、要素ごとのアニメーションとページ切り替え、発表者モード（レーザーポインター・ペン描画注釈 + WebSocket ベースの**視聴者リアルタイム追従プレゼンテーション**）、ページ・要素単位のコメント、バージョン履歴、オフラインページ下書きマージ、PPTX インポート・エクスポート、PDF 印刷 |
| **ホワイトボード・マインドマップ** | 無限キャンバス、フローチャートとスイムレーン、ブレインストーミング機能（付箋・蛍光ペン・ドット投票・カウントダウン・ミニマップ・グループフレーム）、多様なレイアウトのマインドマップ、境界線・サマリー・バッジ、アウトラインとの双方向同期、Mermaid / XMind / SVG / PNG エクスポート |
| **ナレッジベース・クラウドドライブ・全文検索** | **マルチワークスペースの完全なライフサイクル管理**（作成、ワンクリック切り替え、名前変更、所有権移転 UI/API、メンバー退出、削除）、独立したナレッジベース空間と多階層ディレクトリ、ショートカット、**ワークスペース横断移動（個人・共有・ワークスペース間）**、**ストレージ使用量ダッシュボードとクォータ超過ブロック（HTTP 413）**、**あらゆる形式のオンラインプレビュー**（画像の拡大縮小・回転、PDF、音声・動画、コード / Markdown / CSV、`.docx` / `.xlsx` / `.pptx`、公開読み取り専用ドキュメント添付ファイルのリッチプレビューを含む）、**純 Go による添付ファイル本文抽出 + プラガブル OCR（HTTP / OpenAI Vision / `tesseract`）+ 既存添付ファイルのワンクリック / CLI バックフィルによるインデックス再構築** |
| **AI ネイティブワークスペース** | **ハイブリッド意味ベクトル + BM25 RAG によるワークスペース全体のナレッジベース Q&A**（128 次元ローカルベクトル + 任意の外部 `/embeddings` + 権限分離 + ドキュメントおよび PDF / Office / OCR 添付ファイルの引用元トレーサビリティ）、**ワークスペース全体と単一ドキュメントの 2 系統 SSE トークンストリーミング出力**（`POST /api/ai/workspace-ask/stream` · `POST /api/ai/doc/stream`）、スプレッドシート AI 数式生成、多次元テーブル AI 一括入力、OpenAI / Anthropic 互換マルチモデル接続（API キー未設定時はローカルエンジンへ自動フォールバック） |
| **エンタープライズ IAM・ディレクトリ同期** | **OIDC / OAuth2 + SAML 2.0 SP**（Metadata XML、AuthnRequest、ネイティブ XML-DSig RSA/ECDSA 署名検証および XXE/XSW 対策）、**SCIM 2.0（RFC 7644 完全実装）**（`ServiceProviderConfig`、`Schemas`、`ResourceTypes`、`Users` / `Groups` の `PUT` / `PATCH` / `DELETE`・フィルタ・ページネーション対応）、**LDAP v3 / WeCom / DingTalk のオンデマンド同期および定期同期**（ネイティブ ASN.1 BER クライアント + 暗号化認証情報）、**TOTP MFA + 8 個のリカバリーコード + ワークスペース強制 MFA ポリシーとグローバル上部ガイドバナー**、**WebAuthn / Passkeys（FIDO2 ES256/RS256）パスワードレスログイン**、**アカウントセキュリティのセルフサービス完結フロー**（ログイン / MFA / Passkey / 公開リンクのブルートフォース対策レート制限、パスワード変更、SMTP パスワードリセット、アクティブログイン端末一覧とリモートログアウト） |
| **セキュリティ・コンプライアンス・オープンエコシステム** | **エンタープライズ DLP（機密語句・安全な RE2 正規表現による情報漏えい防止）**（Doc / Sheet / Base / Slides / Survey に対応、公開共有や CSV / 公開添付ファイルのエクスポートをブロック・警告）、**データ保持期間ポリシーとバックグラウンド定期・手動パージ**、スイート全体の情報漏えい防止ウォーターマーク、公開共有パスワード、エンタープライズ監査ログと CSV エクスポート、**OpenAPI 3.1.0 完全仕様（361 エンドポイント 100% ルート網羅検証 + 27 データモデル + インタラクティブ開発者ポータル）**、**PAT（個人用アクセストークン）**、**全 6 カテゴリのワークスペースイベント向け HMAC-SHA256 Webhook**、**外部通知チャネル**（SMTP / Feishu / DingTalk / WeCom / Slack） |
| **高可用性・国際化・クラウドネイティブ** | **4 大リアルタイム共同編集 Hub のマルチレプリカ水平スケーリング**（Doc `syncsrv` / Base `btsync` / Sheet `sheetsync` / Slides `slidessync` はすべて PostgreSQL の `LISTEN/NOTIFY` によるノード間ブロードキャストに対応）、**リポジトリ全体での中国語・英語バイリンガル完全国際化**（5,355 エントリ、ユーザー可視箇所の翻訳漏れ 0 件）、**ルート単位の `React.lazy` + Rollup コード分割**（メインバンドル 308 KB / gzip 84 KB）、PWA + IndexedDB オフライン編集と再接続時の自動マージ（Doc / Base / Sheet / Slides）、`/healthz` + `/readyz` + Prometheus `/metrics` + W3C `traceparent`、SHA-256 検証付きフルバックアップ・リストア CLI（`jiange backup` / `restore` / `reindex-attachments`）、本番環境向け **Helm Chart** と **Kustomize** マニフェスト |

### 製品画面プレビュー

<table>
  <tr>
    <td align="center" width="50%">
      <img src="design/screenshots/cloud-doc.png" alt="クラウドドキュメント" width="100%" /><br />
      <b>クラウドドキュメント（Cloud Doc）</b><br />
      <sub>独自 CRDT リアルタイム／オフライン共同編集・見出しアウトライン・リッチブロック</sub>
    </td>
    <td align="center" width="50%">
      <img src="design/screenshots/sheet.png" alt="スプレッドシート" width="100%" /><br />
      <b>スプレッドシート（Sheet）</b><br />
      <sub>WebGPU 仮想グリッド・148 個の組み込み数式関数・スパークラインとチャート</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="design/screenshots/base.png" alt="多次元テーブル" width="100%" /><br />
      <b>多次元テーブル（Base）</b><br />
      <sub>23 種のフィールド・グリッド／カンバン／ガント／階層ビュー・AI 一括入力</sub>
    </td>
    <td align="center" width="50%">
      <img src="design/screenshots/slides.png" alt="スライド" width="100%" /><br />
      <b>スライド（Slides）</b><br />
      <sub>WebGPU キャンバス・ベクターチャート／表・マスタースライドと PPTX 連携</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="design/screenshots/board.png" alt="ホワイトボード・マインドマップ" width="100%" /><br />
      <b>ホワイトボード・マインドマップ（Board &amp; MindMap）</b><br />
      <sub>無限キャンバス・スイムレーンフローチャート・マインドマップとミニマップ</sub>
    </td>
    <td align="center" width="50%">
      <img src="design/screenshots/workspace-ai.png" alt="ナレッジベース AI Q&A" width="100%" /><br />
      <b>AI ネイティブワークスペース（Workspace AI）</b><br />
      <sub>ハイブリッドベクトル + BM25 RAG 検索とクリック可能な出典引用</sub>
    </td>
  </tr>
</table>

---

## クイックスタート

用途に応じて、**フル機能のセルフホストスイート**、**npm TypeScript/WebGPU SDK**、**Go 組み込み可能バックエンド SDK**、または **Go CLI / AI MCP Server** の 4 つの方法で Jiange を導入できます：

### 1. フル機能のコラボレーションスイートをワンコマンドで起動（Docker）

```bash
# 方法 A：Docker Compose で一括起動（Postgres 16 + MinIO + Jiange フルスイート）
git clone https://github.com/ZSeven-W/jiange.git && cd jiange
docker compose up -d --build
# http://localhost:8080 にアクセスし、最初のワークスペース管理者を登録すれば利用を開始できます

# 方法 B：GHCR からビルド済みマルチアーキテクチャイメージを直接プル（linux/amd64 & linux/arm64）
docker pull ghcr.io/zseven-w/jiange:latest
docker run -d --name jiange -p 8080:8080 \
  -e DATABASE_URL="postgres://jiange:jiange@host.docker.internal:5432/jiange?sslmode=disable" \
  -e JIANGE_SECURE_COOKIES="false" \
  -e JIANGE_SECRET_KEY="$(openssl rand -hex 32)" \
  -v jiange_blobs:/data/blobs \
  ghcr.io/zseven-w/jiange:latest
```

> 本番 Kubernetes 環境へのデプロイには Helm Chart（`helm upgrade --install jiange ./deploy/helm/jiange`）をそのままご利用ください。詳細は [deploy/README.md](deploy/README.md) を参照してください。

### 2. TypeScript / WebGPU SDK を利用する（npm `@zseven-w/*`）

**サードパーティ依存ゼロの全 13 パッケージ**が npmjs.com（`0.2.0`）に公開されており、モジュール単位で個別にインストールできます：

```bash
# 必要なヘッドレスエンジンを個別インストール（Node.js / ブラウザ / Edge / AI Agent で動作）
npm install @zseven-w/sheet-sdk        # スプレッドシート（148 関数 + XLSX/CSV + AI ツール）
npm install @zseven-w/doc-sdk          # クラウドドキュメント（CRDT + MD/HTML/DOCX + コメント・変更履歴）
npm install @zseven-w/base-sdk         # 多次元テーブル（23 フィールド + 7 ビュー + 数式・リレーション）
npm install @zseven-w/slides-sdk       # スライド（PPTX + 純 TS 16:9 SVG）
npm install @zseven-w/whiteboard-sdk   # ホワイトボード・マインドマップ（Mermaid + DAG レイアウト + XMind）

# オプション：WebGPU/WebGL2 + 仮想リスト UI コンポーネントをインストール（ゼロ Canvas 2D、ネイティブ mount / React / Web Components 対応）
npm install @zseven-w/sheet-ui @zseven-w/doc-ui @zseven-w/base-ui @zseven-w/slides-ui @zseven-w/whiteboard-ui
```

ヘッドレス数式計算 + AI ツールによる試算（`dryRun`）+ `.xlsx` エクスポートの例：

```ts
import { Workbook, createSheetTools } from "@zseven-w/sheet-sdk";

const wb = Workbook.fromCsv("Product,Units,UnitPrice\nPro,120,49\nEnterprise,25,299\n", "Q4");
const tools = createSheetTools(wb);

// AI Agent は dryRun で事前検証してから適用でき、数式は自動で増分再計算されます
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
const xlsxBytes = await wb.toXlsxAsync();   // 標準 DEFLATE 圧縮の .xlsx バイト列
```

ブラウザに WebGPU/WebGL2 仮想グリッドをマウントする例（ネイティブ DOM / React / `<jiange-sheet>` のいずれでも利用可能）：

```ts
import { mountSheetView } from "@zseven-w/sheet-ui";

const view = await mountSheetView(document.getElementById("sheet-root")!, wb);
// 破棄時に view.dispose() を呼び出します
```

### 3. Go サービスにバックエンド SDK を組み込む（`sdk/go` & `sdk/go-pgstore`）

```bash
go get github.com/ZSeven-W/jiange/sdk/go@v0.2.0
go get github.com/ZSeven-W/jiange/sdk/go-pgstore@v0.2.0   # オプションの PostgreSQL 永続化アダプター
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
		Store:   storage.NewMemoryStore(), // 本番環境では pgstore.New(db) に差し替え可能
		Auth:    storage.NewBearerTokenAuth(map[string]storage.Principal{"my-token": {ID: "u-1", Name: "Admin", Roles: []string{"admin"}}}),
		Version: "0.2.0",
	})
	mux := http.NewServeMux()
	mux.Handle("/api/v1/", http.StripPrefix("/api/v1", app))
	_ = http.ListenAndServe(":8090", mux)
}
```

### 4. Go CLI と AI Agent MCP Server を利用する（`jiange`）

```bash
# Go Module からインストール（または GitHub Releases から 5 プラットフォーム向けのビルド済み静的バイナリをダウンロード）
go install github.com/ZSeven-W/jiange/cli/cmd/jiange@v0.2.0

# ローカルでオフィスファイルを直接読み書き（Node.js 依存ゼロ）
jiange sheet inspect budget.xlsx --detail full
jiange sheet patch budget.xlsx --ops '[{"op":"setCell","sheet":"Sheet1","a1":"B2","raw":"=SUM(A1:A10)"}]' --out out.xlsx
jiange doc convert spec.md --out spec.docx
jiange slides render deck.pptx --slide 0 --out slide1.svg
jiange board render arch.mmd --out arch.svg

# MCP Server を起動（stdio または Streamable HTTP に対応）
jiange mcp --transport stdio
jiange mcp --transport http --addr 127.0.0.1:8787
```

**Claude Desktop / Cursor / Antigravity** などの MCP クライアントに直接設定できます：

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

> ビルド済み CLI バイナリ（Linux / macOS / Windows `amd64` & `arm64`）および全 SDK のオフラインパッケージは [GitHub Releases (`sdk-v0.2.0`)](https://github.com/ZSeven-W/jiange/releases/tag/sdk-v0.2.0) を、完全な API リファレンスは [sdk-docs/getting-started.md](sdk-docs/getting-started.md) を参照してください。

---

## ディレクトリ構成

```text
apps/web              Jiange 本体の Web フロントエンド (React + Vite + TS + TanStack Query + Tailwind + shadcn/ui)
server/               Jiange 本体の Go バックエンド: cmd/jiange, internal/{api,auth,backup,blob,btformula,btquery,btsync,config,httpx,migrate,sheetstore,sheetsync,slidessync,store,syncsrv,tableadmission}, collab
packages/
  ooxml               L0: ゼロ依存の同期 STORE + 非同期 DEFLATE ZIP および安全な境界付き XML パーサー
  collab              L0: 共同編集コア (RGA/Fugue CRDT, オフラインスナップショット復元と自動マージ, Undo, ./table, ./ws, ./storage, ./ai-agent)
  sheet-sdk           L1: ヘッドレス AI-Native スプレッドシート SDK (AST+DAG 増分数式エンジン 148 関数, XLSX/CSV, Worker)
  doc-sdk             L1: ヘッドレス AI-Native ドキュメント SDK (Document Facade, MD/HTML/DOCX, コメントと変更履歴)
  slides-sdk          L1: ヘッドレス AI-Native プレゼンテーション SDK (Presentation, PPTX, 純 TS 16:9 SVG, メディアとトリミング)
  whiteboard-sdk      L1: ヘッドレス AI-Native ホワイトボード・マインドマップ SDK (Board, Mermaid 双方向, DAG レイアウト, XMind, SVG)
  base-sdk            L1: ゼロ依存ヘッドレス AI-Native 多次元テーブル SDK (23 フィールド, 7 ビュー, 数式, リレーション・ルックアップ, ダッシュボード, CSV)
  render-gpu          L2: ゼロ Canvas 2D レンダリングコア (WebGPU/WebGL2 SDF+GlyphAtlas, 100 万行 Fenwick 仮想リスト, SpatialIndex)
  {sheet,doc,slides,whiteboard,base}-ui
                      L2: 5 つの独立した軽量 UI SDK (ネイティブ mount, ./react, <jiange-*> Web Components)
cli/                  ゼロ外部依存の Go 1.23 ネイティブ CLI & Streamable HTTP/stdio MCP Server (単一静的バイナリ ~5.5 MB)
sdk/go/               ゼロ外部依存の Go 1.23 組み込み可能バックエンド SDK (10 パッケージ: storage, sync, 5 ドメインエンジン, ai, server, client)
sdk/go-pgstore/       オプションの PostgreSQL storage.Store アダプター (標準 database/sql, pgx/v5/stdlib と lib/pq に互換)
sdk-docs/             完全な SDK 利用ガイド、API リファレンス、AI-Native プロトコル、WebGPU UI および Go 組み込みドキュメント
deploy/               本番環境向け Kubernetes Helm Chart (deploy/helm/jiange)、Kustomize マニフェスト (deploy/k8s) および運用ガイド
e2e/                  Playwright 自動ブラウザ E2E 回帰テストスイート (GitHub Actions CI の `e2e` パイプラインと連携)
benchmarks/           RFC §7 定量パフォーマンス SLA、バンドルサイズ、ゼロ Canvas 2D および 13 パッケージ隔離インストール自動ゲート
examples/             実行可能なサンプル: ts-headless、go-backend、ビルド不要の WebGPU/WebGL2 ui-playground
design/               OpenPencil デザインソースファイル（jiange.op）およびプロモーション動画プロジェクト（promo/jiange-promo.op + mp4）
spec/                 PROTOCOL.md 共同編集プロトコル仕様 + vectors/ TS/Go クロスランゲージ整合性テストベクター
docker-compose.yml    Postgres + MinIO
```

## SDK・運用ドキュメント

- **SDK ドキュメントトップ**：[sdk-docs/README.md](sdk-docs/README.md)
- **5 分クイックスタート**：[sdk-docs/getting-started.md](sdk-docs/getting-started.md)
- **Headless TS SDK マニュアル**：[sdk-docs/headless-sdks.md](sdk-docs/headless-sdks.md)
- **WebGPU/WebGL2 + 仮想リスト UI SDK マニュアル**：[sdk-docs/gpu-ui-sdks.md](sdk-docs/gpu-ui-sdks.md)
- **AI-Native プロトコル・ツール仕様**：[sdk-docs/ai-native-protocol.md](sdk-docs/ai-native-protocol.md)
- **Go バックエンド SDK・PostgreSQL アダプター・Go CLI / MCP**：[sdk-docs/go-backend-and-cli.md](sdk-docs/go-backend-and-cli.md)
- **パフォーマンスベンチマーク・バンドルサイズ・リリースガイド**：[sdk-docs/performance-and-release.md](sdk-docs/performance-and-release.md)
- **全体概要とアーキテクチャ要約**：[headless-sdk.md](headless-sdk.md)
- **本番デプロイ・Helm / K8s・バックアップ＆リストアガイド**：[deploy/README.md](deploy/README.md)
- **Playwright E2E テストマニュアル**：[e2e/README.md](e2e/README.md)

## 許可された基盤ライブラリ

| レイヤー | 依存関係 |
|---|---|
| Headless & GPU SDK (`packages/*`) | **サードパーティのランタイム依存ゼロ**（純粋な ES2022 TypeScript） |
| Go SDK & CLI (`sdk/go`, `sdk/go-pgstore`, `cli`) | **サードパーティのランタイム依存ゼロ**（純粋な Go 1.23 標準ライブラリ） |
| Web App (`apps/web`) | react, react-dom, @tanstack/react-query, tailwindcss, shadcn/ui（およびその @radix-ui/*, class-variance-authority, clsx, tailwind-merge） |
| Main Server (`server/`) | Go 標準ライブラリ stdlib（純 Go 実装の SAML 2.0 / LDAP v3 BER / WebAuthn CBOR+COSE / PDF+OOXML テキスト抽出 / Prometheus を含む）, github.com/jackc/pgx/v5, github.com/coder/websocket |
| Dev & E2E | vite, typescript, vitest, tsx, @playwright/test |

Yjs、Tiptap、ProseMirror、および重量級の DI コンテナ、Web フレームワーク、ORM は一切使用していません。

## ローカル起動と本番運用

動作要件：Node 20+、pnpm 10、Go 1.23+（`server/` は `server/go.mod` に一致する Go バージョンが必要）、Docker（Postgres 用）。

```bash
pnpm install
docker compose up -d postgres            # postgres://jiange:jiange@localhost:5432/jiange

cd server && go run ./cmd/jiange         # :8080、起動時にマイグレーション (0001..0092) を自動実行
# 別ターミナルで実行
pnpm --filter @jiange/web dev            # http://localhost:5173 (/api および /scim を :8080 へプロキシ)
```

データバックアップ・リストアおよび添付ファイル全文インデックスのバックフィル：

```bash
cd server
go run ./cmd/jiange backup /path/to/jiange-backup.tar.gz
go run ./cmd/jiange restore /path/to/jiange-backup.tar.gz
go run ./cmd/jiange reindex-attachments [workspaceId]
```

ビルド不要の WebGPU/WebGL2 + 仮想リスト UI SDK Playground を試す：

```bash
pnpm -r build
node examples/ui-playground/serve.mjs    # http://127.0.0.1:4173
```

環境変数：`DATABASE_URL`、`JIANGE_ADDR`（デフォルト `:8080`）、`JIANGE_SESSION_TTL`（デフォルト `720h`）、HTTPS 配下では `JIANGE_SECURE_COOKIES=true`、`JIANGE_SECRET_KEY`（AI キー・SSO シークレット・LDAP / WeCom / DingTalk コネクタ認証情報・Webhook および通知チャネルシークレットの AES-256-GCM 暗号化用）、`JIANGE_METRICS_TOKEN`（`/metrics` を保護する任意の Bearer トークン）、`JIANGE_AI_EMBEDDING_MODEL`（任意の外部 `/embeddings` モデル名）、`JIANGE_OCR_URL` / `JIANGE_OCR_MODE` / `JIANGE_OCR_API_KEY` / `JIANGE_OCR_TESSERACT`（画像およびスキャン PDF 向けの任意 OCR 設定）、`JIANGE_BLOB_DIR`（ローカルディスクの Blob 保存ディレクトリ。設定時は S3 より優先）。

ドキュメントの未確定操作に対する安全なキャンセル機能（Conditional Cancel）はデフォルトで無効です。デプロイ時は先にデータベースマイグレーションを適用し、古いドキュメント書き込みインスタンスをすべてアップグレードおよびドレインした上で `JIANGE_ENABLE_CONDITIONAL_CANCEL=true` を設定してください。有効化後は、停止バリアに対応していない旧インスタンスから再度書き込みを行わないでください。詳細は [docs/deploy.md](docs/deploy.md) および [deploy/README.md](deploy/README.md) を参照してください。

### 添付ファイル（MinIO / S3）

`JIANGE_S3_ENDPOINT`（例：`http://localhost:9000`）、`JIANGE_S3_ACCESS_KEY`、`JIANGE_S3_SECRET_KEY`、および任意の `JIANGE_S3_BUCKET`（デフォルト `jiange`、起動時に自動作成）を設定します。エンドポイント（または `JIANGE_BLOB_DIR`）が未設定の場合、アップロード機能は無効になります。docker-compose 環境では `JIANGE_S3_ENDPOINT=http://localhost:9000 JIANGE_S3_ACCESS_KEY=jiange JIANGE_S3_SECRET_KEY=jiange-dev-secret` を指定してください。

## テストと品質ゲート

```bash
pnpm lint:names                          # リポジトリ全体の kebab-case パス検証（1,960+ 追跡パス）
pnpm -r build && pnpm -r typecheck       # 全 13 個の SDK/UI パッケージ + apps/web のビルドと型チェック
pnpm test                                # リポジトリ全体の Vitest ユニットテスト（apps/web 313 ファイル / 1,814 テストケース）
pnpm test:sdk:coverage                   # 全 13 個の TS SDK/UI パッケージで 100/100/100/100 V8 カバレッジゲート
pnpm test:sdk:pack                       # 実際の pnpm pack による隔離 Node ESM および NodeNext 型検証
pnpm test:e2e                            # Playwright ブラウザ E2E 回帰テスト（ログイン・ワークスペース・4 アプリ・管理画面・バイリンガル・オフライン）
pnpm bench                               # RFC §7 の全 7 項目パフォーマンス SLA、ゼロ Canvas 2D、13 パッケージ隔離インストール検証
pnpm gen:vectors                         # 共同編集コア変更後に spec/vectors を再生成

cd cli && go test -race -cover ./...             # Go CLI & MCP (4 パッケージ 100.0% カバレッジ)
cd sdk/go && go test -race -cover ./...          # Go バックエンド SDK (10 パッケージ 100.0% カバレッジ)
cd sdk/go-pgstore && go test -race -cover ./...  # PostgreSQL アダプター (100.0% カバレッジ)
cd server && go test ./... && go vet ./...       # Jiange メインサーバー全 20 パッケージテスト（OpenAPI 100% ルート整合性・マルチレプリカ同期を含む）
JIANGE_TEST_DATABASE_URL=postgres://jiange:jiange@localhost:5432/jiange_test?sslmode=disable go test ./internal/store
go test ./collab -run '^$' -fuzz '^FuzzDecode$' -fuzztime 30s
```

クロスランゲージ整合性：TypeScript 側が `spec/vectors/encoding.json`（ops ↔ 16 進バイト列）と `scenarios.json`（ops → 期待されるマテリアライズドビュー、5 つのランダムな 3 レプリカセッションを含む）を生成します。Go 側のテストはエンコードをバイト単位で照合し、25 通りのランダムな順序入れ替えと重複配信で各シナリオをリプレイして、TS と完全に一致する結果を検証します。

## 認証・可観測性・オープン API

全 361 エンドポイントの完全なコントラクトは `GET /api/openapi.json` から直接取得できるほか、管理画面の「開発者 / API」タブでインタラクティブに閲覧および cURL コマンドのコピーが可能です。

| Method | Path | 説明 |
|---|---|---|
| GET | `/healthz` · `/readyz` · `/metrics` | Liveness プローブ、DB / ストレージ Readiness プローブ、および Prometheus 0.0.4 メトリクス |
| GET | `/api/openapi.json` | 完全な OpenAPI 3.1.0 仕様（361 エンドポイント、27 データモデル） |
| GET/POST/PUT/PATCH/DELETE | `/scim/v2/{ServiceProviderConfig,Schemas,ResourceTypes,Users,Groups}` | RFC 7643/7644 SCIM 2.0 による組織メンバーおよびグループ同期（`admin` スコープの PAT） |
| POST | `/api/auth/register` · `/api/auth/login` · `/api/auth/mfa/verify` · `/api/auth/password-reset/{request,confirm}` | ユーザー登録、パスワードログイン（レート制限、TOTP / リカバリーコード 2 段階認証、強制 MFA ポリシー対応）、および SMTP パスワードリセット |
| POST | `/api/auth/passkey/login/{begin,finish}` | WebAuthn / Passkeys（FIDO2 ES256/RS256）パスワードレスログイン |
| GET/POST | `/api/auth/sso/{slug}/{start,callback,metadata.xml,acs}` | エンタープライズ OIDC / OAuth2 および SAML 2.0 SP シングルサインオン |
| GET/POST/DELETE | `/api/me` · `/api/me/password` · `/api/me/sessions` · `/api/me/passkeys` · `/api/me/tokens` | ログイン中ユーザー情報、パスワード変更、アクティブ端末セッション管理・強制ログアウト、パスキー、PAT トークン |
| GET/POST/PATCH/DELETE | `/api/workspaces` · `/api/workspaces/{wsId}` | マルチワークスペースの作成、切り替え、名前変更、所有権移転（`/transfer-owner`）、退出（`/leave`）、削除 |
| GET/PUT/POST | `/api/workspaces/{wsId}/storage` · `/storage/quota` · `/attachments/reindex` | ワークスペース容量ダッシュボード、クォータ上限設定（413 ブロック）、既存添付ファイルの全文・OCR インデックス再構築 |
| POST | `/api/workspaces/{wsId}/org/sync-sources/{sourceId}/pull` | LDAP v3 / WeCom / DingTalk からのオンデマンドディレクトリ同期トリガー（Dry-Run 対応） |
| POST | `/api/workspaces/{wsId}/dlp/check` · `/retention/run` | エンタープライズ DLP 機密語句・正規表現のリアルタイムテスト、およびデータ保持期間に基づく即時パージ |
| POST | `/api/ai/ask-workspace` · `/api/ai/workspace-ask/stream` · `/api/ai/doc/stream` | ハイブリッド意味ベクトル RAG によるワークスペース全体 Q&A および単一ドキュメント AI ライティング（いずれも SSE ストリーミング出力対応） |
| GET/POST | `/api/workspaces/{wsId}/webhooks` · `/notification-channels` | 全 6 カテゴリのワークスペースイベント向け HMAC-SHA256 Webhook および外部通知チャネル（SMTP / Feishu / DingTalk / WeCom / Slack） |

セッション管理：32 バイトのランダムトークンを発行し、サーバーには SHA-256 ハッシュのみを保存します（Cookie は `HttpOnly; SameSite=Lax`）。パスワードハッシュ：PBKDF2-HMAC-SHA256（600k 反復、Go 標準ライブラリ `crypto/pbkdf2`）。書き込みリクエストは `application/json` を必須とします（`SameSite` と組み合わせて CSRF を防止。SAML HTTP-POST ACS およびカスタムヘッダー付きアップロードエンドポイントを除く）。

## デザイン

UI はまず OpenPencil（`design/jiange.op`）で設計され、プレビューは `design/previews/` に格納されています。デザイン変数（`design/vars.json`）は `apps/web/src/index.css` 内の Tailwind / shadcn テーマ変数にマッピングされます。プロモーション動画は OpenPencil v0.8.6 のネイティブ `.op` モーション機能で書き出しています（`design/promo/jiange-promo.op`）。

## ライセンス

本プロジェクトはコンポーネント別ライセンスを採用しています。全文は [LICENSE](./LICENSE) をご確認ください。

- **アプリケーション部分（`apps/`、`server/` 等）**：個人利用および非商用利用は無料です。商用利用（企業内での本番業務利用、ホスティング / SaaS 提供、商用製品や有料サービスへの組み込み等を含む）には、事前の商用ライセンス購入が必要です。
- **SDK 部分（`packages/*`、`sdk/*`、`cli/*`）**：個人利用・商用利用ともにすべて無料です。ただし、企業が SDK の二次開発（改変、拡張、機能抜粋、またはソースコードに基づく派生開発）を行う場合は、製品ドキュメント、About ページ、ソースコードリポジトリの説明などの公開箇所に「Jiange SDK に基づく」旨の出典を明記する必要があります。

---

ファイル名およびディレクトリ名はデフォルトで kebab-case を採用し、コード内の識別子は各言語の慣例に従います。Go のプラットフォーム・テスト用サフィックス、適用済みのデータベースマイグレーションファイル名、`README.md` / `README.<lang>.md`、`CHANGELOG.md`、`Dockerfile`、`Chart.yaml`、`NOTES.txt`、`_helpers.tpl`、ライセンスファイル等はツールの規約を維持します。`pnpm lint:names` により Git 管理下のパスを検証できます。SDK には互換エントリポイントとして従来の camelCase サブパスが残されていますが、新規コードでは kebab-case サブパスを使用してください。
