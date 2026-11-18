# 独立普通电子表格（`kind="sheet"`）工作簿上线验证报告（2026-11-18）

补齐 P0 差距中的「独立普通电子表格（Sheet）」产品形态：从开发预览与隔离存储原型升级为一等持久化云盘资源节点（`kind="sheet"`、`#/sheet/{id}`），提供服务端 PostgreSQL / Memory 双引擎持久化、多工作表增删改排、跨表公式计算与高亮引用、单元格样式与合并/冻结/筛选排序、多工作表 `.xlsx` 导入导出、WebSocket 实时协作者光标与版本同步，以及全站主页/云盘/侧栏/全局搜索/副本/分享/回收站闭环。

## 主要改动

- **数据库迁移与服务端存储层**：
  - [0065_sheets.sql](server/internal/migrate/sql/0065_sheets.sql)：扩展 `nodes_kind_check` 支持 `'sheet'`，新增 `sheet_workbooks`、`sheet_worksheets`（`DEFERRABLE` 排序位置唯一约束）、`sheet_rows`、`sheet_columns`、`sheet_cells`（空单元格版本墓碑防旧写覆写）及 `sheet_write_receipts`（基于 `mutationId` 与载荷 SHA-256 摘要的幂等回执，`ON DELETE CASCADE` 关联 `nodes`）。
  - [sheets.go](server/internal/store/sheets.go)、[sheets-memory.go](server/internal/store/sheets-memory.go)、[sheets-pg.go](server/internal/store/sheets-pg.go) 与 `store.go` / `memory.go` / `docs.go` / `drive-folder.go`：实现 Memory 与 PostgreSQL 对等 `SheetStore`（创建/读取工作簿、并发版本号校验写格、工作表增删重命名排序、冻结/合并/筛选更新、插入/删除/调整行列与合并范围联动、`ReplaceSheetWorkbook` 多表导入、`CopySheetWorkbook` 事务级副本拷贝、`SearchSheetContent` 单元格内容检索及回收站清理）。
- **实时同步与 REST/WS 接口**：
  - [sheetsync.go](server/internal/sheetsync/sheetsync.go)：新增多协作者光标/活跃工作表在线状态广播与工作簿修订推进推送中心，接入 [main.go](server/cmd/jiange/main.go)。
  - [sheets.go](server/internal/api/sheets.go) 与 `api.go` / `drive.go` / `duplicate.go` / `search-favorites.go` / `share.go` / `link-revision.go`：提供 `/api/sheets/{id}`、`/api/sheets/{id}/cells`、`/api/sheets/{id}/worksheets`、`/api/sheets/{id}/import-xlsx`、`/api/sheets/{id}/account-title` 及 `/api/sheets/{id}/ws`；强制校验 `X-Jiange-User-Id` 账号归属与 `X-Jiange-Sheet-Version: "1"` 协议头，并与云盘新建、副本继承、全局搜索、直接/链接分享隔离集成。
- **前端工作簿界面、公式引擎与全站接入**：
  - [sheet-page.tsx](apps/web/src/pages/sheet/sheet-page.tsx)、[sheet-toolbar.tsx](apps/web/src/pages/sheet/sheet-toolbar.tsx)：对齐飞书「工作表标签栏位于格式化工具栏上方」布局，支持面包屑与标题行内重命名、置顶、ShareDialog、格式刷、字体/字号/粗斜下划线/删除线/前景色/填充色/边框/对齐/自动换行/数字与货币百分比日期格式、合并与取消合并、冻结行列、按列筛选与升降序、查找替换、拖拽填充柄、TSV+公式剪贴板粘贴、会话撤销/重做、空表快速模板条，以及只读协作者状态与错误类型 `ResourceTypeNotice` 回退。
  - [workbook-engine.ts](apps/web/src/pages/sheet/workbook-engine.ts)、[workbook-xlsx.ts](apps/web/src/pages/sheet/workbook-xlsx.ts)、[workbook-templates.ts](apps/web/src/pages/sheet/workbook-templates.ts)：支持多工作表跨表公式求值、循环引用/报错防护、点击/聚焦编辑栏时的 `#ff8800` 橘色引用高亮与点击选格插入引用，以及多工作表 `.xlsx` 导入预览确认与导出。
  - 全站入口整合：`apps/web/src/components/feishu-icons.tsx` 新增绿色 `SheetColorIcon`；`lib/route.ts` 与 `lib/api.ts` 注册 `#/sheet/{id}` 与 `sheetsApi`；`app.tsx`、`home.tsx`、`home-file-actions.ts`、`drive-page.tsx`、`components/sidebar.tsx`、`components/global-search.tsx`、`pages/trash.tsx`、`share-dialog.tsx`、`share-link.tsx`、`i18n/en.ts` 与 `vite.config.ts`（`/api/sheets` WebSocket 代理）全部打通。

## 浏览器截图与端到端验证

在隔离 `postgres:16-alpine` 容器、本地 Go 服务（`:8080`）、Vite 开发服务器（`:5173`）与无头 Chrome（CDP `:19222`）中运行 [验证脚本](scripts/verify-sheet-workbook.mjs)，返回 `{"sheetId":21,"copyId":22,"verified":["desktop","xlsx-roundtrip","home-filter","duplicate","search-cell","trash","mobile-390x844"]}`：

- [桌面端（1440 × 900）：多工作表布局、跨表公式结果、#ff8800 引用高亮、货币格式、冻结行与合并单元格](jiange-sheet-workbook-desktop-20261118.png)
- [桌面端（1440 × 900）：主页「表格」筛选、副本保留与全局搜索命中表格单元格内容](jiange-sheet-home-search-20261118.png)
- [模拟移动端（390 × 844）：窄屏顶栏避让侧栏开关及表格内部横向滚动无溢出](jiange-sheet-mobile-20261118.png)

端到端验证覆盖：主页「新建 → 表格」进入 `#/sheet/{id}` 且校验 `kind === "sheet"`；重命名工作簿、新建 `Sheet2` 并写入跨表公式 `=SUM(B2:C2)+Sheet2!A1` 得到 `16000` 与 `#ff8800` 选区高亮；货币格式、合并与取消合并状态、`冻结首行`；实际导出多工作表 `.xlsx` 并通过网页文件选择器重新导入与整页刷新持久化；主页按「表格」筛选与创建保留双工作表数据的副本；全局搜索按单元格文本 `飞书对齐专案` 命中并展示图标；移至回收站核验「表格」标签；以及 390 × 844 模拟移动视口无重叠、无页面级横向溢出的界面截图审查。

## 测试结果

- Go 单元与存储/接口集成测试：`cd server && go test ./...` 全部通过（含 `TestMemorySheetStore`、`TestPostgresSheetStore`、`TestSheetSyncPresenceAndRevision`、`TestSheetAPILifecycleAndSecurity`）。
- 隔离 PostgreSQL 跨包集成验证：`JIANGE_TEST_DATABASE_URL=... go test -p 1 -count=1 ./internal/store ./internal/api ./internal/sheetsync` 全部通过（注：`internal/store` 与 `internal/api` 共用测试库 `public` schema 时，并发跨包运行曾触发 `TestPostgresTitleReconcile` `401`，按包顺序 `-p 1` 执行全量通过）。
- 前端、SDK 与构建验证：`pnpm typecheck`（7 个 workspace 项目全通过）、`pnpm test`（`@jiange/web` 共 228 个测试文件 / 1292 项测试全部通过，含 [workbook-engine.test.ts](apps/web/src/pages/sheet/workbook-engine.test.ts)、[sheet-page.test.tsx](apps/web/src/pages/sheet/sheet-page.test.tsx)、`i18n.test.ts`、`home-view.test.tsx`、`global-search.test.ts` 等）、`pnpm test:sdk:pack`（5 个 headless SDK 与 OOXML 库 ESM/NodeNext 校验通过）、`pnpm --filter @jiange/web build` 与 `pnpm lint:names` 全通过。

## Review 后修复（2026-11-18）

- **XLSX 格式保真**：`@jiange/sheet-sdk` 的 XLSX 读写新增单元格样式（粗体/斜体/下划线/删除线、字体与字号、文字色、填充色、水平/垂直对齐、自动换行、细边框与边框色、数字格式）、合并单元格与冻结窗格；网页端在导出时写入、导入时还原，货币/百分比/小数/整数/日期格式按 Excel 格式代码互转。导出再导入后样式、合并与冻结不再丢失（见 `workbook-xlsx.test.ts` 与 SDK 往返测试）。仍不保留：列宽/行高、主题色与索引色（回退为默认颜色并提示）、渐变填充、粗/虚线边框样式（导入为细边框并提示）、条件格式与数据验证。
- **复制/下载限制**：分享弹窗的「权限设置」对表格开放（「谁可以复制内容」「谁可以创建副本、打印和下载」，表格暂无评论项）；服务端 `PATCH /api/docs/{id}` 与 `PatchManagedDocGuarded` 接受表格的复制/下载策略并拒绝评论策略。表格页按策略拦截单元格复制/剪切、编辑栏与单元格输入框复制，并隐藏导出 XLSX 与创建副本入口；服务端创建副本继续按下载策略校验。与文档相同，复制/导出限制在客户端执行，查看者仍能读取工作簿数据。
- **写入回执清理**：`sheet_write_receipts` 保留 24 小时，每次写同一工作簿时顺带删除过期回执（迁移 `0066_sheet_receipt_retention.sql` 增加 `(node_id, created_at)` 索引）；过期后重试会因版本校验冲突而失败，不会重复写入。内存存储同步实现。
- **全局搜索**：表格内容匹配改为在 PostgreSQL 内用 `strpos(lower(...))` 判断并提前返回，不再把所有单元格传到 Go 逐个折叠比较。注意这仍是按工作簿的顺序扫描而非索引查找：任意子串匹配需要 `pg_trgm` 三元组索引，本次未引入数据库扩展；`lower()` 与 Unicode 完整折叠在少数字符（如 `ß`→`ss`）上不一致。
- **写入锁**：单元格写入不再对 `nodes` 行加 `FOR UPDATE`，改为共享锁，写入方在 `sheet_workbooks` 行上串行；列表用的 `updated_at` 最多每 5 秒更新一次且用 `SKIP LOCKED` 不等待，避免与读者死锁。读取和其他鉴权操作不再排在写入后面。同一工作簿的写入仍按工作簿修订号串行（修订号必须单调且按提交顺序递增，才能保证客户端的版本推送不漏更新）。

## 已知边界

- 表格的高级增强项（单元格数据验证规则、条件格式、嵌入式图表与数据透视表、基于单格坐标的锚点评论、受保护单元格区域细粒度权限，以及 `.xlsx` 中列宽/行高、主题色和复杂边框的保真）仍属于 **P1** 后续扩展范围。
- 本次跨端验证基于 macOS 本地无头 Chrome（桌面 `1440 × 900` 与模拟移动端 `390 × 844`），真机移动端触控与中文输入法组合输入，以及针对当前登录态飞书实页的逐像素样式校对仍待补充核验。
