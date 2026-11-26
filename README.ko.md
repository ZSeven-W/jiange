# Jiange

<p align="center">
  <img src="apps/web/public/brand/jiange-lockup.svg" width="240" alt="Jiange" />
</p>

<p align="center">
  <a href="README.md">简体中文</a> ·
  <a href="README.en.md">English</a> ·
  <a href="README.zh-TW.md">繁體中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <b>한국어</b> ·
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
  <strong>오픈소스 Feishu / Lark 대안 올인원 협업 스위트 (문서 + 스프레드시트 + 다차원 테이블 + 슬라이드 + 화이트보드/마인드맵)</strong><br />
  <sub>AI 네이티브 · 경량 및 모듈 분리 가능 · 엔터프라이즈 보안 컴플라이언스 · 멀티 레플리카 고가용성 · 전체 저장소 이중 언어 및 오프라인 CRDT · 제로 Canvas 2D (WebGPU/WebGL2 + 가상 리스트)</sub>
</p>

<p align="center">
  Feishu / Lark의 Docs, Sheets, Base, Slides, Whiteboard / MindMap을 대체할 수 있는 오픈소스·셀프호스팅·엔터프라이즈급 AI 네이티브 협업 스위트입니다. 자체 개발 CRDT 엔진, Go 표준 라이브러리 기반 백엔드(SAML 2.0, OIDC, SCIM 2.0, LDAP / WeCom / DingTalk, WebAuthn Passkeys, DLP, Prometheus, OpenAPI 3.1), 외부 의존성이 없는 13개의 TypeScript / WebGPU SDK, 그리고 단일 바이너리 Go CLI &amp; MCP Server까지 처음부터 직접 구축했습니다.
</p>

---

## 프로모션 영상

<p align="center">
  <a href="design/promo/jiange-promo.mp4">
    <img src="design/promo/jiange-promo-cover.png" alt="Jiange 프로모션 영상 — 클릭하여 재생" width="100%" />
  </a>
</p>

<p align="center">
  <sub>
    ▶ <a href="design/promo/jiange-promo.mp4"><b>전체 프로모션 영상 보기 (MP4 · 30s · 오리지널 BGM 포함)</b></a><br />
    영상 모션은 <b>OpenPencil v0.8.6</b> 네이티브 <code>.op</code> 프로젝트로 제작 및 내보내기(<a href="design/promo/jiange-promo.op"><code>design/promo/jiange-promo.op</code></a> / <a href="design/promo/build-jiange-promo.py">생성 스크립트</a>)되었으며, 배경음악은 로컬 <b>MiniMax H3-Music</b> 기악 모델로 생성했습니다.
  </sub>
</p>

---

## 핵심 제품 기능

| 모듈 | 핵심 기능 |
|---|---|
| **클라우드 문서** | 자체 개발 RGA/Fugue CRDT 실시간 협업, **완전한 오프라인 CRDT 협업 편집 및 재연결 시 자동 병합**(IndexedDB 로컬 레플리카 영속화), 15+ 블록 유형(네이티브 `audio` / `video` / `poll` 실시간 투표 / `countdown` 카운트다운 / `tabs` 탭 / 표 / 코드 블록 / 수식 / Mermaid / 동기화 블록 / 다단 레이아웃 / 임베디드 테이블 포함), **인라인 변경 내용 추적 모드(Track Changes)**, 텍스트 선택 댓글 및 이모지 반응, 따라 읽기 모드, 버전 기록, DOCX / Markdown(이미지 포함) 가져오기·내보내기 및 PDF 인쇄 |
| **스프레드시트** | WebGPU/WebGL2 기반 100만 행 가상 그리드, **148개 내장 수식 함수**(`XLOOKUP` / `FILTER` / `SORT` / `UNIQUE` / `LET` / `LAMBDA` / `ARRAYFORMULA` / `QUERY` / `REGEX*` / `IMAGE` 포함), 플로팅 차트, 피벗 테이블, **셀 내 SVG 스파크라인(Sparklines)**, 행/열 접기 그룹화, 셀 내 이미지, 조건부 서식 / 데이터 유효성 검사 / 보호 영역, 클라우드 이름 지정 범위, 버전 기록 및 셀 변경 이력, 오프라인 셀 증분 병합, XLSX / CSV 가져오기·내보내기, **AI 수식 어시스턴트** |
| **다차원 테이블 (Base)** | 다중 테이블 및 테이블 간 양방향 관계 연결, **23종 필드 유형**(통화, 진행률, 자동 번호, 액션 버튼, 위치 정보, 수식, 관계, 조회 등 포함), **7종 뷰**(그리드, 칸반, 의존성 연결선 지원 간트 차트, 캘린더, 갤러리, **계층 트리 뷰**, 조건부 분기 공개 폼), 최대 3단계 중첩 그룹화, 다단계 자동화 워크플로, 데이터 대시보드, 다중 역할 기반의 세분화된 행/열 단위 RBAC, XLSX / CSV 가져오기·내보내기, **AI 열 단위 일괄 채우기** |
| **슬라이드** | WebGPU/WebGL2 캔버스, **슬라이드 마스터 및 브랜드 키트(Master Brand Kit)**, 텍스트 / 도형 / 표 / 차트 / 비디오 / 오디오 개체, 이미지 자르기, 요소별 애니메이션 및 화면 전환, 발표자 모드(레이저 포인터 / 펜 주석 + WebSocket 기반 **청중 실시간 팔로우 프레젠테이션**), 페이지 및 요소별 댓글, 버전 기록, 오프라인 페이지 초안 병합, PPTX 가져오기·내보내기 및 PDF 인쇄 |
| **화이트보드 & 마인드맵** | 무한 캔버스, 플로차트 및 스윔레인, 브레인스토밍 도구(포스트잇 / 형광펜 / 도트 투표 / 카운트다운 / 미니맵 / 그룹 프레임), 다중 구조 마인드맵, 외곽선 / 요약 / 배지, 개요(아웃라인)와의 양방향 동기화, Mermaid / XMind / SVG / PNG 내보내기 |
| **지식 베이스 · 클라우드 드라이브 · 전문 검색** | **멀티 워크스페이스 전체 수명 주기 관리**(생성, 원클릭 전환, 이름 변경, 소유권 이전 UI/API, 멤버 탈퇴, 삭제), 독립 지식 베이스 공간 및 다단계 디렉터리, 바로가기, **공간 간 이동(개인 / 공유 / 워크스페이스 간)**, **워크스페이스 스토리지 사용량 대시보드 및 할당량 초과 차단(HTTP 413)**, **모든 파일 형식 온라인 미리보기**(이미지 확대·축소·회전, PDF, 오디오·비디오, 코드 / Markdown / CSV, `.docx` / `.xlsx` / `.pptx`, 공개 읽기 전용 문서의 첨부 파일 리치 미리보기 포함), **순수 Go 첨부 파일 본문 전문 추출 + 플러그형 OCR(HTTP / OpenAI Vision / `tesseract`) + 기존 첨부 파일 원클릭/CLI 백필을 통한 인덱스 재구축** |
| **AI 네이티브 워크스페이스** | **하이브리드 시맨틱 벡터 + BM25 RAG 기반 전체 워크스페이스 지식 베이스 Q&A**(128차원 로컬 벡터 + 선택적 원격 `/embeddings` + 권한 격리 + 문서 및 PDF / Office / OCR 첨부 파일 출처 인용 추적), **워크스페이스 전체 및 단일 문서 듀얼 SSE 토큰 스트리밍 출력**(`POST /api/ai/workspace-ask/stream` · `POST /api/ai/doc/stream`), 스프레드시트 AI 수식 생성, 다차원 테이블 AI 일괄 채우기, OpenAI / Anthropic 호환 멀티 모델 연동(API 키가 없으면 로컬 엔진으로 자동 폴백) |
| **엔터프라이즈 IAM & 디렉터리 동기화** | **OIDC / OAuth2 + SAML 2.0 SP**(Metadata XML, AuthnRequest, 네이티브 XML-DSig RSA/ECDSA 서명 검증 및 XXE/XSW 방어), **SCIM 2.0(RFC 7644 완전 구현)**(`ServiceProviderConfig`, `Schemas`, `ResourceTypes`, `Users` / `Groups` 전체 `PUT` / `PATCH` / `DELETE` / 필터링 / 페이지네이션), **LDAP v3 / WeCom / DingTalk 수동 풀(Pull) 및 예약 동기화**(네이티브 ASN.1 BER 클라이언트 + 암호화된 자격 증명), **TOTP MFA + 복구 코드 8개 + 워크스페이스 강제 MFA 정책 및 전역 상단 안내 배너**, **WebAuthn / Passkeys(FIDO2 ES256/RS256) 비밀번호 없는 로그인**, **계정 보안 셀프서비스 완결 흐름**(로그인 / MFA / Passkey / 공개 링크 무차별 대입 방지 속도 제한, 비밀번호 변경, SMTP 비밀번호 찾기·재설정, 활성 로그인 기기 목록 및 원격 로그아웃) |
| **보안 컴플라이언스 & 오픈 생태계** | **엔터프라이즈 DLP 민감어 및 안전한 RE2 정규식 유출 방지**(Doc / Sheet / Base / Slides / Survey 적용, 공개 공유 및 CSV / 공개 첨부 파일 내보내기 차단·경고), **데이터 보존 기간 정책 및 백그라운드 예약/수동 정리**, 전체 스위트 유출 방지 워터마크, 공개 공유 비밀번호, 엔터프라이즈 보안 감사 로그 및 CSV 내보내기, **OpenAPI 3.1.0 전체 명세(361개 엔드포인트 100% 라우트 커버리지 검증 + 27개 데이터 모델 + 인터랙티브 개발자 포털)**, **PAT 개인 액세스 토큰**, **전체 6종 워크스페이스 이벤트 HMAC-SHA256 Webhook**, **외부 알림 채널**(SMTP / Feishu / DingTalk / WeCom / Slack) |
| **고가용성 · 국제화 · 클라우드 네이티브** | **4대 실시간 협업 Hub 전체 멀티 레플리카 수평 확장**(Doc `syncsrv` / Base `btsync` / Sheet `sheetsync` / Slides `slidessync` 모두 PostgreSQL `LISTEN/NOTIFY` 기반 노드 간 브로드캐스트 지원), **저장소 전체 중국어/영어 완전 이중 언어 국제화**(5,355개 항목, 사용자 노출 누락 0건), **라우트 단위 `React.lazy` + Rollup 코드 스플리팅**(메인 번들 308 KB / gzip 84 KB), PWA + IndexedDB 오프라인 편집 및 재연결 자동 병합(Doc / Base / Sheet / Slides), `/healthz` + `/readyz` + Prometheus `/metrics` + W3C `traceparent`, SHA-256 무결성 검증 전체 백업·복원 CLI(`jiange backup` / `restore` / `reindex-attachments`), 프로덕션급 **Helm Chart** 및 **Kustomize** 매니페스트 |

### 제품 화면 미리보기

<table>
  <tr>
    <td align="center" width="50%">
      <img src="design/screenshots/cloud-doc.png" alt="클라우드 문서" width="100%" /><br />
      <b>클라우드 문서 (Cloud Doc)</b><br />
      <sub>자체 CRDT 실시간/오프라인 협업, 목차 개요 및 리치 블록 편집</sub>
    </td>
    <td align="center" width="50%">
      <img src="design/screenshots/sheet.png" alt="스프레드시트" width="100%" /><br />
      <b>스프레드시트 (Sheet)</b><br />
      <sub>WebGPU 가상 그리드, 148개 내장 수식 함수 및 플로팅 차트</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="design/screenshots/base.png" alt="다차원 테이블" width="100%" /><br />
      <b>다차원 테이블 (Base)</b><br />
      <sub>23종 필드, 그리드/칸반/간트/계층 뷰 및 AI 열 일괄 채우기</sub>
    </td>
    <td align="center" width="50%">
      <img src="design/screenshots/slides.png" alt="슬라이드" width="100%" /><br />
      <b>슬라이드 (Slides)</b><br />
      <sub>WebGPU 캔버스, 벡터 차트/표, 마스터 브랜드 키트 및 PPTX 호환</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="design/screenshots/board.png" alt="화이트보드 & 마인드맵" width="100%" /><br />
      <b>화이트보드 &amp; 마인드맵 (Board &amp; MindMap)</b><br />
      <sub>무한 캔버스, 스윔레인 플로차트, 마인드맵 및 미니맵 내비게이션</sub>
    </td>
    <td align="center" width="50%">
      <img src="design/screenshots/workspace-ai.png" alt="지식 베이스 AI Q&A" width="100%" /><br />
      <b>워크스페이스 AI Q&amp;A (Workspace AI)</b><br />
      <sub>하이브리드 시맨틱 벡터 + BM25 RAG 검색 및 클릭 가능한 출처 인용</sub>
    </td>
  </tr>
</table>

---

## 빠른 시작

필요에 따라 **완전한 셀프호스팅 스위트**, **npm TypeScript/WebGPU SDK**, **Go 임베딩 가능 백엔드 SDK**, 또는 **Go CLI / AI MCP Server**의 4가지 방식으로 Jiange를 도입할 수 있습니다:

### 1. 전체 협업 스위트 원클릭 실행 (Docker)

```bash
# 방식 A: Docker Compose 원클릭 실행 (Postgres 16 + MinIO + Jiange 전체 스위트)
git clone https://github.com/ZSeven-W/jiange.git && cd jiange
docker compose up -d --build
# http://localhost:8080 에 접속해 첫 워크스페이스 관리자를 등록하면 바로 사용할 수 있습니다

# 방식 B: GHCR 사전 빌드 멀티 아키텍처 이미지 직접 풀 (linux/amd64 & linux/arm64)
docker pull ghcr.io/zseven-w/jiange:latest
docker run -d --name jiange -p 8080:8080 \
  -e DATABASE_URL="postgres://jiange:jiange@host.docker.internal:5432/jiange?sslmode=disable" \
  -e JIANGE_SECURE_COOKIES="false" \
  -e JIANGE_SECRET_KEY="$(openssl rand -hex 32)" \
  -v jiange_blobs:/data/blobs \
  ghcr.io/zseven-w/jiange:latest
```

> 프로덕션 Kubernetes 배포에는 Helm Chart(`helm upgrade --install jiange ./deploy/helm/jiange`)를 바로 사용하세요. 자세한 내용은 [deploy/README.md](deploy/README.md)를 참고하세요.

### 2. TypeScript / WebGPU SDK 사용 (npm `@zseven-w/*`)

**서드파티 의존성이 전혀 없는 13개 패키지**가 모두 npmjs.com(`0.2.0`)에 배포되어 있으며, 모듈별로 개별 설치할 수 있습니다:

```bash
# 필요한 헤드리스 엔진만 선택 설치 (Node.js / 브라우저 / Edge / AI Agent 모두 지원)
npm install @zseven-w/sheet-sdk        # 스프레드시트 (148개 수식 + XLSX/CSV + AI 도구)
npm install @zseven-w/doc-sdk          # 클라우드 문서 (CRDT + MD/HTML/DOCX + 댓글 및 변경 추적)
npm install @zseven-w/base-sdk         # 다차원 테이블 (23종 필드 + 7종 뷰 + 수식·관계)
npm install @zseven-w/slides-sdk       # 슬라이드 (PPTX + 순수 TS 16:9 SVG)
npm install @zseven-w/whiteboard-sdk   # 화이트보드 & 마인드맵 (Mermaid + DAG 레이아웃 + XMind)

# 선택 사항: WebGPU/WebGL2 + 가상 리스트 UI 컴포넌트 설치 (제로 Canvas 2D, 네이티브 mount / React / Web Components 포함)
npm install @zseven-w/sheet-ui @zseven-w/doc-ui @zseven-w/base-ui @zseven-w/slides-ui @zseven-w/whiteboard-ui
```

헤드리스 수식 계산 + AI 도구 사전 검증(`dryRun`) + `.xlsx` 내보내기 예제:

```ts
import { Workbook, createSheetTools } from "@zseven-w/sheet-sdk";

const wb = Workbook.fromCsv("Product,Units,UnitPrice\nPro,120,49\nEnterprise,25,299\n", "Q4");
const tools = createSheetTools(wb);

// AI Agent가 dryRun으로 먼저 검증한 뒤 적용하며, 수식은 자동으로 증분 재계산됩니다
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
const xlsxBytes = await wb.toXlsxAsync();   // 표준 DEFLATE .xlsx 바이트 스트림
```

브라우저에 WebGPU/WebGL2 가상 그리드 마운트 (네이티브 DOM / React / `<jiange-sheet>` 모두 지원):

```ts
import { mountSheetView } from "@zseven-w/sheet-ui";

const view = await mountSheetView(document.getElementById("sheet-root")!, wb);
// 정리 시 view.dispose() 호출
```

### 3. Go 서비스에 백엔드 SDK 임베딩 (`sdk/go` & `sdk/go-pgstore`)

```bash
go get github.com/ZSeven-W/jiange/sdk/go@v0.2.0
go get github.com/ZSeven-W/jiange/sdk/go-pgstore@v0.2.0   # 선택적 PostgreSQL 영속화 어댑터
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
		Store:   storage.NewMemoryStore(), // 프로덕션에서는 pgstore.New(db)로 교체 가능
		Auth:    storage.NewBearerTokenAuth(map[string]storage.Principal{"my-token": {ID: "u-1", Name: "Admin", Roles: []string{"admin"}}}),
		Version: "0.2.0",
	})
	mux := http.NewServeMux()
	mux.Handle("/api/v1/", http.StripPrefix("/api/v1", app))
	_ = http.ListenAndServe(":8090", mux)
}
```

### 4. Go CLI 및 AI Agent MCP Server 사용 (`jiange`)

```bash
# Go Module로 설치 (또는 GitHub Releases에서 5개 플랫폼 사전 빌드 정적 바이너리 직접 다운로드)
go install github.com/ZSeven-W/jiange/cli/cmd/jiange@v0.2.0

# 로컬에서 오피스 파일 직접 읽기/쓰기 (Node.js 의존성 제로)
jiange sheet inspect budget.xlsx --detail full
jiange sheet patch budget.xlsx --ops '[{"op":"setCell","sheet":"Sheet1","a1":"B2","raw":"=SUM(A1:A10)"}]' --out out.xlsx
jiange doc convert spec.md --out spec.docx
jiange slides render deck.pptx --slide 0 --out slide1.svg
jiange board render arch.mmd --out arch.svg

# MCP Server 실행 (stdio 또는 Streamable HTTP 지원)
jiange mcp --transport stdio
jiange mcp --transport http --addr 127.0.0.1:8787
```

**Claude Desktop / Cursor / Antigravity** 등의 MCP 클라이언트에서 바로 설정할 수 있습니다:

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

> 사전 빌드된 CLI 바이너리(Linux / macOS / Windows `amd64` & `arm64`)와 전체 SDK 오프라인 패키지는 [GitHub Releases (`sdk-v0.2.0`)](https://github.com/ZSeven-W/jiange/releases/tag/sdk-v0.2.0)에서 확인할 수 있으며, 전체 API 레퍼런스는 [sdk-docs/getting-started.md](sdk-docs/getting-started.md)를 참고하세요.

---

## 디렉터리 구조

```text
apps/web              Jiange 메인 제품 Web 프런트엔드 (React + Vite + TS + TanStack Query + Tailwind + shadcn/ui)
server/               Jiange 메인 제품 Go 백엔드: cmd/jiange, internal/{api,auth,backup,blob,btformula,btquery,btsync,config,httpx,migrate,sheetstore,sheetsync,slidessync,store,syncsrv,tableadmission}, collab
packages/
  ooxml               L0: 제로 의존성 동기 STORE + 비동기 DEFLATE ZIP 및 경계 보안 XML 파서
  collab              L0: 협업 코어 (RGA/Fugue CRDT, 오프라인 스냅샷 복원 및 자동 병합, Undo, ./table, ./ws, ./storage, ./ai-agent)
  sheet-sdk           L1: 헤드리스 AI-Native 스프레드시트 SDK (AST+DAG 증분 수식 엔진 148개 함수, XLSX/CSV, Worker)
  doc-sdk             L1: 헤드리스 AI-Native 문서 SDK (Document Facade, MD/HTML/DOCX, 댓글 및 변경 추적)
  slides-sdk          L1: 헤드리스 AI-Native 프레젠테이션 SDK (Presentation, PPTX, 순수 TS 16:9 SVG, 미디어 및 자르기)
  whiteboard-sdk      L1: 헤드리스 AI-Native 화이트보드/마인드맵 SDK (Board, Mermaid 양방향, DAG 레이아웃, XMind, SVG)
  base-sdk            L1: 제로 의존성 헤드리스 AI-Native 다차원 테이블 SDK (23종 필드, 7종 뷰, 수식, 관계·조회, 대시보드, CSV)
  render-gpu          L2: 제로 Canvas 2D 렌더링 코어 (WebGPU/WebGL2 SDF+GlyphAtlas, 100만 행 Fenwick 가상 리스트, SpatialIndex)
  {sheet,doc,slides,whiteboard,base}-ui
                      L2: 5개의 독립 경량 UI SDK (네이티브 mount, ./react, <jiange-*> Web Components)
cli/                  외부 의존성 제로 Go 1.23 네이티브 CLI & Streamable HTTP/stdio MCP Server (단일 정적 바이너리 ~5.5 MB)
sdk/go/               외부 의존성 제로 Go 1.23 임베딩 가능 백엔드 SDK (10개 패키지: storage, sync, 5개 도메인 엔진, ai, server, client)
sdk/go-pgstore/       선택적 PostgreSQL storage.Store 어댑터 (표준 database/sql, pgx/v5/stdlib 및 lib/pq 호환)
sdk-docs/             전체 SDK 사용 가이드, API 레퍼런스, AI-Native 프로토콜, WebGPU UI 및 Go 연동 문서
deploy/               프로덕션급 Kubernetes Helm Chart (deploy/helm/jiange), Kustomize 매니페스트 (deploy/k8s) 및 운영 매뉴얼
e2e/                  Playwright 자동 브라우저 E2E 회귀 테스트 스위트 (GitHub Actions CI `e2e` 파이프라인 연동)
benchmarks/           RFC §7 정량 성능 SLA, 번들 크기, 제로 Canvas 2D 및 13개 패키지 격리 설치 자동 게이트
examples/             실행 가능한 예제: ts-headless, go-backend, 무빌드 WebGPU/WebGL2 ui-playground
design/               OpenPencil 디자인 원본 파일(jiange.op) 및 프로모션 영상 프로젝트(promo/jiange-promo.op + mp4)
spec/                 PROTOCOL.md 협업 프로토콜 명세 + vectors/ TS/Go 크로스 랭귀지 일관성 테스트 벡터
docker-compose.yml    Postgres + MinIO
```

## SDK 및 운영 문서

- **SDK 문서 홈**: [sdk-docs/README.md](sdk-docs/README.md)
- **5분 빠른 시작**: [sdk-docs/getting-started.md](sdk-docs/getting-started.md)
- **Headless TS SDK 매뉴얼**: [sdk-docs/headless-sdks.md](sdk-docs/headless-sdks.md)
- **WebGPU/WebGL2 + 가상 리스트 UI SDK 매뉴얼**: [sdk-docs/gpu-ui-sdks.md](sdk-docs/gpu-ui-sdks.md)
- **AI-Native 프로토콜 및 도구 명세**: [sdk-docs/ai-native-protocol.md](sdk-docs/ai-native-protocol.md)
- **Go 백엔드 SDK, PostgreSQL 어댑터 및 Go CLI / MCP**: [sdk-docs/go-backend-and-cli.md](sdk-docs/go-backend-and-cli.md)
- **성능 벤치마크, 번들 크기 및 릴리스 가이드**: [sdk-docs/performance-and-release.md](sdk-docs/performance-and-release.md)
- **개요 및 아키텍처 요약**: [headless-sdk.md](headless-sdk.md)
- **프로덕션 배포, Helm / K8s 및 백업·복원 가이드**: [deploy/README.md](deploy/README.md)
- **Playwright E2E 테스트 매뉴얼**: [e2e/README.md](e2e/README.md)

## 허용된 기반 라이브러리

| 계층 | 의존성 |
|---|---|
| Headless & GPU SDK (`packages/*`) | **서드파티 런타임 의존성 제로**(순수 ES2022 TypeScript) |
| Go SDK & CLI (`sdk/go`, `sdk/go-pgstore`, `cli`) | **서드파티 런타임 의존성 제로**(순수 Go 1.23 표준 라이브러리) |
| Web App (`apps/web`) | react, react-dom, @tanstack/react-query, tailwindcss, shadcn/ui(및 관련 @radix-ui/*, class-variance-authority, clsx, tailwind-merge) |
| Main Server (`server/`) | Go 표준 라이브러리 stdlib(순수 Go SAML 2.0 / LDAP v3 BER / WebAuthn CBOR+COSE / PDF+OOXML 텍스트 추출 / Prometheus 포함), github.com/jackc/pgx/v5, github.com/coder/websocket |
| Dev & E2E | vite, typescript, vitest, tsx, @playwright/test |

Yjs, Tiptap, ProseMirror 및 무거운 DI 컨테이너, 웹 프레임워크, ORM은 일절 사용하지 않습니다.

## 로컬 실행 및 프로덕션 운영

요구 사항: Node 20+, pnpm 10, Go 1.23+(`server/`는 `server/go.mod`와 일치하는 Go 버전 필요), Docker(Postgres용).

```bash
pnpm install
docker compose up -d postgres            # postgres://jiange:jiange@localhost:5432/jiange

cd server && go run ./cmd/jiange         # :8080, 시작 시 마이그레이션(0001..0092) 자동 실행
# 별도 터미널에서 실행
pnpm --filter @jiange/web dev            # http://localhost:5173 (/api 및 /scim -> :8080 프록시)
```

데이터 백업·복원 및 첨부 파일 전문 인덱스 백필:

```bash
cd server
go run ./cmd/jiange backup /path/to/jiange-backup.tar.gz
go run ./cmd/jiange restore /path/to/jiange-backup.tar.gz
go run ./cmd/jiange reindex-attachments [workspaceId]
```

무빌드 WebGPU/WebGL2 + 가상 리스트 UI SDK Playground 체험:

```bash
pnpm -r build
node examples/ui-playground/serve.mjs    # http://127.0.0.1:4173
```

환경 변수: `DATABASE_URL`, `JIANGE_ADDR`(기본값 `:8080`), `JIANGE_SESSION_TTL`(기본값 `720h`), HTTPS 환경에서 `JIANGE_SECURE_COOKIES=true`, `JIANGE_SECRET_KEY`(AI 키 / SSO 시크릿 / LDAP·WeCom·DingTalk 커넥터 자격 증명 / Webhook 및 알림 채널 시크릿의 AES-256-GCM 암호화용), `JIANGE_METRICS_TOKEN`(`/metrics` 보호용 선택적 Bearer 토큰), `JIANGE_AI_EMBEDDING_MODEL`(선택적 원격 `/embeddings` 모델명), `JIANGE_OCR_URL` / `JIANGE_OCR_MODE` / `JIANGE_OCR_API_KEY` / `JIANGE_OCR_TESSERACT`(이미지 및 스캔 PDF용 선택적 OCR 설정), `JIANGE_BLOB_DIR`(로컬 디스크 Blob 저장 디렉터리, 설정 시 S3보다 우선).

문서의 미확정 작업에 대한 안전 취소 기능(Conditional Cancel)은 기본적으로 비활성화되어 있습니다. 배포 시 먼저 데이터베이스 마이그레이션을 적용하고 기존의 모든 문서 쓰기 인스턴스를 업그레이드 및 드레인한 뒤 `JIANGE_ENABLE_CONDITIONAL_CANCEL=true`를 설정하세요. 활성화한 이후에는 중지 배리어를 지원하지 않는 구버전 인스턴스가 다시 쓰기를 수행하지 않도록 해야 합니다. 자세한 내용은 [docs/deploy.md](docs/deploy.md) 및 [deploy/README.md](deploy/README.md)를 참고하세요.

### 첨부 파일 (MinIO / S3)

`JIANGE_S3_ENDPOINT`(예: `http://localhost:9000`), `JIANGE_S3_ACCESS_KEY`, `JIANGE_S3_SECRET_KEY`와 선택적으로 `JIANGE_S3_BUCKET`(기본값 `jiange`, 시작 시 자동 생성)을 설정합니다. 엔드포인트(또는 `JIANGE_BLOB_DIR`)가 설정되지 않으면 파일 업로드 기능이 비활성화됩니다. docker-compose 환경에서는 `JIANGE_S3_ENDPOINT=http://localhost:9000 JIANGE_S3_ACCESS_KEY=jiange JIANGE_S3_SECRET_KEY=jiange-dev-secret`를 사용하세요.

## 테스트 및 품질 게이트

```bash
pnpm lint:names                          # 전체 저장소 kebab-case 경로 검사 (1,960+ 추적 경로)
pnpm -r build && pnpm -r typecheck       # 전체 13개 SDK/UI 패키지 + apps/web 빌드 및 타입 검사
pnpm test                                # 전체 저장소 Vitest 단위 테스트 (apps/web 313개 파일 / 1,814개 테스트 케이스)
pnpm test:sdk:coverage                   # 전체 13개 TS SDK/UI 패키지 100/100/100/100 V8 커버리지 게이트
pnpm test:sdk:pack                       # 실제 pnpm pack 격리 환경 Node ESM 및 NodeNext 타입 검증
pnpm test:e2e                            # Playwright 브라우저 E2E 회귀 테스트 (로그인/워크스페이스/4종 앱/관리자 콘솔/이중 언어/오프라인)
pnpm bench                               # RFC §7 전체 7개 성능 SLA, 제로 Canvas 2D 및 13개 패키지 격리 설치 검증
pnpm gen:vectors                         # 협업 코어 수정 후 spec/vectors 재생성

cd cli && go test -race -cover ./...             # Go CLI & MCP (4개 패키지 100.0% 커버리지)
cd sdk/go && go test -race -cover ./...          # Go 백엔드 SDK (10개 패키지 100.0% 커버리지)
cd sdk/go-pgstore && go test -race -cover ./...  # PostgreSQL 어댑터 (100.0% 커버리지)
cd server && go test ./... && go vet ./...       # Jiange 메인 서버 20개 패키지 전체 테스트 (OpenAPI 100% 라우트 일치 및 멀티 레플리카 동기화 포함)
JIANGE_TEST_DATABASE_URL=postgres://jiange:jiange@localhost:5432/jiange_test?sslmode=disable go test ./internal/store
go test ./collab -run '^$' -fuzz '^FuzzDecode$' -fuzztime 30s
```

크로스 랭귀지 일관성: TypeScript 측에서 `spec/vectors/encoding.json`(ops ↔ 16진수 바이트)과 `scenarios.json`(ops → 기대 구체화 뷰, 무작위 3-레플리카 세션 5개 포함)을 생성합니다. Go 테스트는 바이트 단위로 인코딩을 대조하고, 25가지 무작위 순서 뒤섞기 및 중복 전달 방식으로 각 시나리오를 리플레이하여 TS와 완전히 동일한 결과를 검증합니다.

## 인증, 관측성 및 오픈 API

전체 361개 엔드포인트 명세는 `GET /api/openapi.json`으로 직접 조회하거나 관리자 콘솔의 「개발자 / API」 탭에서 인터랙티브하게 탐색하고 cURL 명령을 복사할 수 있습니다.

| Method | Path | 설명 |
|---|---|---|
| GET | `/healthz` · `/readyz` · `/metrics` | Liveness 프로브, DB / 스토리지 Readiness 프로브 및 Prometheus 0.0.4 모니터링 메트릭 |
| GET | `/api/openapi.json` | 전체 OpenAPI 3.1.0 명세 (361개 엔드포인트, 27개 데이터 모델) |
| GET/POST/PUT/PATCH/DELETE | `/scim/v2/{ServiceProviderConfig,Schemas,ResourceTypes,Users,Groups}` | RFC 7643/7644 SCIM 2.0 조직 구성원 및 그룹 동기화 (`admin` 스코프 PAT) |
| POST | `/api/auth/register` · `/api/auth/login` · `/api/auth/mfa/verify` · `/api/auth/password-reset/{request,confirm}` | 회원가입, 비밀번호 로그인(속도 제한, TOTP / 복구 코드 2단계 인증 및 강제 MFA 정책 포함) 및 SMTP 비밀번호 재설정 |
| POST | `/api/auth/passkey/login/{begin,finish}` | WebAuthn / Passkeys (FIDO2 ES256/RS256) 비밀번호 없는 로그인 |
| GET/POST | `/api/auth/sso/{slug}/{start,callback,metadata.xml,acs}` | 엔터프라이즈 OIDC / OAuth2 및 SAML 2.0 SP 싱글 사인온 |
| GET/POST/DELETE | `/api/me` · `/api/me/password` · `/api/me/sessions` · `/api/me/passkeys` · `/api/me/tokens` | 현재 사용자 정보, 비밀번호 변경, 활성 기기 세션 관리/원격 로그아웃, 패스키 및 PAT 토큰 |
| GET/POST/PATCH/DELETE | `/api/workspaces` · `/api/workspaces/{wsId}` | 멀티 워크스페이스 생성, 전환, 이름 변경, 소유권 이전(`/transfer-owner`), 탈퇴(`/leave`) 및 삭제 |
| GET/PUT/POST | `/api/workspaces/{wsId}/storage` · `/storage/quota` · `/attachments/reindex` | 워크스페이스 스토리지 사용량 대시보드, 할당량 상한 설정(413 차단) 및 기존 첨부 파일 전문·OCR 인덱스 재구축 |
| POST | `/api/workspaces/{wsId}/org/sync-sources/{sourceId}/pull` | LDAP v3 / WeCom / DingTalk 수동 디렉터리 동기화 트리거 (Dry-Run 지원) |
| POST | `/api/workspaces/{wsId}/dlp/check` · `/retention/run` | 엔터프라이즈 DLP 민감어·정규식 실시간 테스트 및 데이터 보존 기간 즉시 정리 |
| POST | `/api/ai/ask-workspace` · `/api/ai/workspace-ask/stream` · `/api/ai/doc/stream` | 하이브리드 시맨틱 벡터 RAG 전체 워크스페이스 Q&A 및 단일 문서 AI 글쓰기 (모두 SSE 토큰 스트리밍 출력 지원) |
| GET/POST | `/api/workspaces/{wsId}/webhooks` · `/notification-channels` | 전체 6종 워크스페이스 이벤트 HMAC-SHA256 Webhook 및 외부 알림 채널 (SMTP / Feishu / DingTalk / WeCom / Slack) |

세션: 32바이트 무작위 토큰을 발급하며 서버에는 SHA-256 해시만 저장합니다(쿠키는 `HttpOnly; SameSite=Lax`). 비밀번호: PBKDF2-HMAC-SHA256(600k회 반복, Go 표준 라이브러리 `crypto/pbkdf2`). 쓰기 요청은 반드시 `application/json`이어야 합니다(`SameSite`와 함께 CSRF 방지, SAML HTTP-POST ACS 및 커스텀 헤더가 포함된 업로드 엔드포인트 제외).

## 디자인

UI는 먼저 OpenPencil(`design/jiange.op`)에서 디자인하며 미리보기는 `design/previews/`에서 확인할 수 있습니다. 디자인 변수(`design/vars.json`)는 `apps/web/src/index.css`의 Tailwind / shadcn 테마 변수로 매핑됩니다. 프로모션 영상은 OpenPencil v0.8.6 네이티브 `.op` 모션 기능으로 내보내기(`design/promo/jiange-promo.op`)했습니다.

## 라이선스

본 프로젝트는 컴포넌트별 라이선스를 적용하며, 전체 약관은 [LICENSE](./LICENSE)에서 확인할 수 있습니다.

- **애플리케이션 영역 (`apps/`, `server/` 등)**: 개인 및 비상업적 용도는 무료입니다. 상업적 용도(기업 내부 운영·비즈니스 활용, 호스팅 / SaaS 제공, 상용 제품 또는 유료 서비스 통합 등 포함)는 사전에 상업용 라이선스를 구매해야 합니다.
- **SDK 영역 (`packages/*`, `sdk/*`, `cli/*`)**: 개인 및 상업적 용도 모두 무료입니다. 단, 기업이 SDK를 2차 개발(수정, 확장, 일부 발췌 또는 소스 코드 기반 파생 개발)하는 경우 제품 문서, 정보(About) 페이지 또는 소스 코드 저장소 안내 등 공개된 위치에 출처(Jiange SDK 기반)를 명확히 표기해야 합니다.

---

파일 및 디렉터리 이름은 기본적으로 kebab-case를 사용하며 코드 식별자는 각 언어의 관례를 따릅니다. Go 플랫폼 및 테스트 접미사, 이미 적용된 데이터베이스 마이그레이션 파일명, `README.md` / `README.<lang>.md`, `CHANGELOG.md`, `Dockerfile`, `Chart.yaml`, `NOTES.txt`, `_helpers.tpl`, 라이선스 파일 등은 도구 규약을 유지하며, `pnpm lint:names`로 Git 추적 경로를 검사할 수 있습니다. SDK는 기존 camelCase 하위 경로를 호환용 진입점으로 유지하지만, 신규 코드에서는 kebab-case 하위 경로를 사용해 주세요.
