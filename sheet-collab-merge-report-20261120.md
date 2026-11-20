# 独立电子表格高并发同格合并与区域级精细协同冲突消解验证报告（2026-11-20）

## 1. 背景与目标

本轮（**P1 Slice 16**）聚焦 [feishu-gap-audit-20261118.md](feishu-gap-audit-20261118.md) 第 3 节「正式工作簿、多工作表、公式与协同基座」遗留的最后一项 P1 核心差距：

1. **高并发同格合并**：此前 `WriteSheetCells` 仅支持整格严格 CAS（`cur.Revision != expectedRevision` 一律返回不透明 `409`），且前端格式化发送整格 `style` 覆盖、行内编辑提交时取最新缓存版本而非起编基准版本，导致同一单元格上「改值 vs 改粗体/底色」正交修改误冲突、批量写入单格冲突拖垮整批数据，以及两人同编同格后提交者静默覆盖前者。
2. **区域级精细协同冲突消解**：此前合并单元格通过 `PATCH /api/sheets/{id}/worksheets/{wid}` 全量覆盖 `merges` 数组，两人并发合并互不重叠区域会后写覆盖前写，重叠合并也缺少结构化冲突提示；向已被合并覆盖的从格并发写入可能静默写入隐藏数据；WebSocket 仅推送单点坐标与整簿刷新信号，缺少区域选区、编辑中状态与增量 `cellDelta` 推送。

## 2. 落地内容与关键文件

### 2.1 数据库迁移与共享并发合并引擎（PG / Memory 对等）
- [`server/internal/migrate/sql/0081_sheet_collab_merge.sql`](server/internal/migrate/sql/0081_sheet_collab_merge.sql)
  - 在 `sheet_cells` 新增 `field_revs jsonb NOT NULL DEFAULT '{}'::jsonb` 字段，按字段记录 `raw` 与 13 项样式属性（`bold`、`italic`、`underline`、`strike`、`fontFamily`、`fontSize`、`color`、`bg`、`align`、`valign`、`wrap`、`borders`、`numFmt`）的最新修订号；兼容历史迁移前行（空 `field_revs` 保守回退为 `cell.Revision`）。
- [`server/internal/store/sheets-merge.go`](server/internal/store/sheets-merge.go)、[`server/internal/store/sheets.go`](server/internal/store/sheets.go)、[`server/internal/store/sheets-memory.go`](server/internal/store/sheets-memory.go)、[`server/internal/store/sheets-pg.go`](server/internal/store/sheets-pg.go)
  - `WriteSheetCells` 新增稀疏 `stylePatch` 与 `mergeMode: "auto"`（默认保持 `"strict"` 完全向后兼容）：
    - **同格正交字段自动合并**：同一单元格并发改值与改样式（或改不同样式项）在服务端单事务内无损合并并返回权威 `raw`/`style`/`revision` 与 `mergedCount`；写入相同值自动收敛。
    - **批量部分提交 + 结构化冲突明细**：多格写入时非冲突单元格正常原子落库，仅将真正同字段冲突单元格记入 `conflicts[]`（含 `reason: "value_conflict" | "style_conflict"`、`currentRaw`/`currentStyle`/`currentRevision`、`updatedBy`/`updatedByName`）。
    - **合并单元格从格写入保护**：`mergeMode: "auto"` 下拦截向合并区域非左上角从格写入非空值，返回 `reason: "merge_slave_conflict"` 及合并区域 `mergeRect` 与主格坐标/版本，防止隐藏脏数据污染公式。
  - `UpdateWorksheetMeta` 新增原子区域操作 `mergeOp`（`op: "merge" | "unmerge"`、`rect`、`expectedMerges`、`force`）：
    - 校验受保护区域权限（`checkProtectedRectWrite`）；
    - 互不重叠的并发合并（如 `A5:B6` 与 `D5:E6`）全部保留；
    - 存在客户端尚未感知的重叠合并时返回类型化 `SheetRegionConflictError`（HTTP `409` JSON：`error: "merge_overlap_conflict"`、`conflictingMerges` 与最新 `worksheet`），用户确认后可用 `force: true` 覆盖。

### 2.2 WebSocket 区域选区在线态与增量 Cell Delta 推送
- [`server/internal/sheetsync/sheetsync.go`](server/internal/sheetsync/sheetsync.go)、[`server/internal/api/sheets.go`](server/internal/api/sheets.go)
  - 扩展 `Collaborator` 携带 `anchorRow`、`anchorCol` 与 `editing` 状态，兼容旧单点 `cursor` 帧。
  - 新增 `Hub.NotifyCells`，对 ≤ 200 格的写格提交随 `revision` 帧下发 `worksheetId` + `cellDelta`，连接端在版本连续时零 HTTP 往返就地增量刷新。

### 2.3 前端协同合并、冲突消解条与区域在线渲染
- [`apps/web/src/pages/sheet/sheet-collab.ts`](apps/web/src/pages/sheet/sheet-collab.ts)、[`apps/web/src/pages/sheet/sheet-conflict-bar.tsx`](apps/web/src/pages/sheet/sheet-conflict-bar.tsx)、[`apps/web/src/pages/sheet/sheet-page.tsx`](apps/web/src/pages/sheet/sheet-page.tsx)、[`apps/web/src/lib/api.ts`](apps/web/src/lib/api.ts)、[`apps/web/src/i18n/en.ts`](apps/web/src/i18n/en.ts)
  - 行内与公式栏编辑记录起编时的 `baseRevision`，避免远端 WS 推送静默掩盖同格并发冲突；格式化操作改为下发稀疏 `stylePatch`。
  - 新增内联冲突消解条 `SheetConflictBar`（`data-sheet-conflict-bar`），支持单元格内容/样式冲突逐条或批量「保留我的 / 采用对方」、合并从格冲突「写入合并主格」，以及区域重叠合并冲突「强制覆盖合并 / 保留协作者合并」。
  - 网格按协作者实时渲染多格选区边框、半透明选区底色与「编辑中」状态徽章，并就地合入连续 WebSocket `cellDelta`。

## 3. 实测验证结果

### 3.1 自动化测试（Go + PostgreSQL 16 + Vitest + SDK + 命名规范）
- `cd server && go test -count=1 ./...`：全部 Go 包通过（含 [`sheets-merge_test.go`](server/internal/store/sheets-merge_test.go)、[`api/sheets-merge_test.go`](server/internal/api/sheets-merge_test.go) 与更新后的 [`sheetsync_test.go`](server/internal/sheetsync/sheetsync_test.go)）。
- 真实 **PostgreSQL 16** 测试（`JIANGE_TEST_DATABASE_URL`）：
  - `TestPostgresSheetConcurrentMerge`（覆盖 3 人同格 `raw+bold+bg` 自动合并、严格模式 409 保底、同值收敛、批量部分提交 + 结构化冲突重基、并发不重叠双区域合并保留、重叠合并 `SheetRegionConflictError` 与 `force` 覆盖、合并从格 `merge_slave_conflict` 拦截，以及 12 并发 Goroutine 同表/同格压测零丢失）：通过。
  - `TestPostgresSheetStore`：通过。
- 前端与无头 SDK 验证：
  - `pnpm typecheck`：7 个工作区包全部通过。
  - `pnpm --filter @jiange/web build`：生产构建通过（4081 模块）。
  - `pnpm test`：全部工作区与前端 Vitest 测试通过（含新增 [`sheet-collab.test.ts`](apps/web/src/pages/sheet/sheet-collab.test.ts) 与 `i18n.test.ts` 全量字典覆盖）。
  - `pnpm test:sdk:pack` 与 `pnpm lint:names`：通过。

### 3.2 双浏览器真实并发端到端与视觉验证（Headless Chrome CDP）
执行 [`scripts/verify-sheet-collab-merge.mjs`](scripts/verify-sheet-collab-merge.mjs) 在真实 PostgreSQL 16 + 编译 Go 后端 + Vite + WebSocket 下同时开启两个隔离 Chrome `BrowserContext`（Alice 与 Bob），并逐张审阅桌面（`1440×900`）与移动端（`390×844`）截图：
- Bob 框选多格区域并双击进入编辑，Alice 实时看到 Bob 选区高亮与「`Bob · 编辑中`」徽章；
- Bob 提交 `B2 = "预算 2026"`，Alice 经 WebSocket 增量 `cellDelta` 即时同步；
- Alice 双击 `A1` 编辑 `=100+250` 期间 Bob 对 `A1` 加粗，Alice 提交后自动合并为加粗 `350`（零冲突条）；
- Alice 与 Bob 并发编辑 `A3`（`Alice方案` vs `Bob方案`），Alice 端弹出 `SheetConflictBar` 展示双版本对比并点击「保留我的」完成重基，双端实时收敛为 `Alice方案`；
- Alice 合并 `A5:B6`、Bob 合并 `D5:E6`，双不重叠合并区域完整保留（`mergesPreserved: 2`）；
- 移动端 `390×844` 下冲突消解条与协作者多格选区布局清晰、**`0px` 水平溢出**，双浏览器全程 **`0` 控制台/页面报错**，刷新后 PostgreSQL 持久化完整保留。

## 4. 边界与后续说明

- 同一单元格内的字符级文本 CRDT 协同（类似富文本文档级同句同字并发插入）仍以单元格值冲突消解（「保留我的 / 采用对方」）为主，与主流在线表格单元格事务语义一致；跨行插入/删除与复杂区域公式同步重基可按后续需求继续深化。
