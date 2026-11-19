# 多维表格可配置多类型仪表盘、原子批量操作与撤销闭环验证报告（2026-11-19）

本轮推进 **P1 Slice 7（多维表格可配置多类型仪表盘、服务端原子批量删改与扩展撤销闭环）**，补齐多维表格（Base）分析与批量记录操作核心差距：持久化多图表仪表盘（`bt_dashboards` + 6 类可视化图表 + 自定义布局持久化 + 副本字段重映射）、服务端单事务原子批量删除/恢复/更新记录，以及支持单条/批量删除恢复与多行批量改写的前端撤销/重做闭环。

## 主要改动

### 1. 数据库迁移与服务端存储层（PostgreSQL + Memory 对等）

- [0077_base_dashboards.sql](server/internal/migrate/sql/0077_base_dashboards.sql)：新增 `bt_dashboards` 表（`id`、`base_id` 外键级联、`name`、`widgets jsonb`、`revision` 乐观锁、`updated_by`、`created_at`/`updated_at`）及索引 `idx_bt_dashboards_base`。
- [base-dashboards.go](server/internal/store/base-dashboards.go) & [base-dashboards.go (API)](server/internal/api/base-dashboards.go)：
  - 实现 `BaseDashboardStore`（PG / Memory 双引擎对等）与 `GET/POST/PATCH/DELETE /api/bases/{id}/dashboards`，复用 `lockBaseWrite` / `checkBaseWriteLocked` 权限与锁定视图写入拦截，支持乐观锁 `expectedRevision`、单表最多 20 个仪表盘与单仪表盘最多 30 个图表组件，并通过 `BtHub.Notify` 实时推送变更。
  - 在 [copy-base-survey.go](server/internal/store/copy-base-survey.go) 的 `CopyBase`（Memory 与 Postgres）中同步克隆 `bt_dashboards`，自动将组件中的 `tableId`、`groupFieldId`、`valueFieldId` 重映射到目标副本表与字段 ID。
- [base-batch.go](server/internal/store/base-batch.go) & [base-batch.go (API)](server/internal/api/base-batch.go)：
  - 新增 `BaseBatchStore`（PG / Memory 对等）与 3 个原子事务端点（单次最多 200 条记录）：
    - `POST /api/bases/{id}/records/batch-delete`：单事务校验全部记录归属与跨表关联写权限，任一记录缺失整体回滚（`404`），成功时返回完整被删记录快照供前端撤销栈记录。
    - `POST /api/bases/{id}/records/batch-restore`：单事务按原位置与单元格快照原子恢复被删除记录，自动过滤已删除或只读计算字段。
    - `POST /api/bases/{id}/records/batch-update`：单事务校验全部记录的 `expected` 预期值，任一单元格发生并发修改整体返回 `409 cells_changed` 且零行部分写入。
  - 路由统一注册于 [api.go](server/internal/api/api.go)，接口接口集入 [store.go](server/internal/store/store.go) 与 [memory.go](server/internal/store/memory.go)。

### 2. 前端多类型仪表盘、桌面/移动批量工具栏与撤销/重做闭环

- [dashboard-model.ts](apps/web/src/pages/base/dashboard-model.ts)、[dashboard-charts.tsx](apps/web/src/pages/base/dashboard-charts.tsx)、[dashboard.tsx](apps/web/src/pages/base/dashboard.tsx)：
  - 实现 6 类飞书风格纯 SVG/Tailwind 数据可视化组件：**指标卡（`metric`）**（支持记录数/求和/均值/最值与勾选进度条）、**柱状图（`bar`）**、**条形图（`horizontal_bar`）**、**环形饼图（`pie`）**、**折线趋势图（`line`，日期字段自动按时间升序）**、**汇总明细表（`pivot`）**。
  - 支持首次自动生成智能默认图表、多仪表盘新建/切换/删除、弹窗可视化添加与编辑图表、卡片左右排序、半宽/全宽切换与恢复默认布局，桌面端采用 6 列栅格（指标卡 3 列并排、图表 2 列并排、宽图满行）。
  - 严格基于当前读者已授权投影后的 `records` 与 `fields` 统计，只读用户或受权限视图限制时隐藏写操作。
- [undo.ts](apps/web/src/pages/base/undo.ts)、[grid.tsx](apps/web/src/pages/base/grid.tsx)、[base-page.tsx](apps/web/src/pages/base-page.tsx)、[api.ts](apps/web/src/lib/api.ts)：
  - `BaseUndoStack` 新增 `deleted` 记录快照支持与 `batchUpdateCells` / `batchDeleteRecords` / `batchRestoreRecords` 原子接口：撤销删除记录时调用 `batch-restore` 原子恢复，重做时原子删回；多行单元格改写撤销/重做自动合入单次 `batch-update` 原子事务。
  - `Grid` 取消桌面端隐藏批量栏的限制，勾选任意行即在桌面与移动端展示「已选择 N 条记录 · 批量删除」工具栏；单条与批量删除均切换至单次 `batch-delete` 原子请求并压入撤销栈。
  - [en.ts](apps/web/src/i18n/en.ts) 补齐全部新增英文词条并通过完整性测试。

## 测试结果

1. **Go 全量与隔离 PostgreSQL 16 `-race` 集成测试**：
   - `cd server && go test -count=1 ./...`：全部 15 个 Go 包无缓存通过。
   - 隔离 `postgres:16-alpine` 容器运行 [base-dashboard-batch_test.go](server/internal/api/base-dashboard-batch_test.go)：`TestBaseDashboardBatchMemory`（0.03s）与 `TestBaseDashboardBatchPostgres`（3.39s）在 `-race` 下全通过，覆盖原子批量更新冲突零修改回滚、缺失 ID 批量删除零删回滚、原子删改恢复闭环、6 类图表持久化与乐观锁冲突、Base 副本仪表盘字段 ID 重映射，以及权限视图下非管理员 `403` 拦截；`internal/migrate` 迁移测试全通过。
2. **前端类型检查、构建与单测**：
   - `pnpm typecheck`（7 个 workspace 项目）、`pnpm --filter @jiange/web build`、`pnpm test`（**241 个测试文件 / 1,335 项测试**，含扩展后的 [dashboard.test.ts](apps/web/src/pages/base/dashboard.test.ts)、[undo.test.ts](apps/web/src/pages/base/undo.test.ts) 与 `i18n.test.ts`）与 `pnpm lint:names`（2,478 条路径）全通过。

## 真实环境与 Chrome CDP 端到端可视化验证

在隔离 `postgres:16-alpine` 容器 + 编译版 Go 服务（`:8080`）+ Vite（`:5174`）+ 无头 Chrome CDP（`:9235`）下执行 [verify-base-dashboard-batch.mjs](scripts/verify-base-dashboard-batch.mjs)，全部断言通过且控制台 0 报错，并完成 5 张桌面与移动端截图视觉审查：

- [01-base-batch-bar.png](output/base-dashboard-batch-20261119/01-base-batch-bar.png)：`1440×900` 桌面端勾选 2 条记录后展示顶部「已选择 2 条记录 · 批量删除」操作栏与右下角聚合统计。
- [02-base-undo-restored.png](output/base-dashboard-batch-20261119/02-base-undo-restored.png)：`1440×900` 原子批量删除 2 条记录（6→4）后点击工具栏撤销，原子恢复原 2 条记录（4→6），顶栏提示「已撤销：删除 2 条记录」。
- [03-dashboard-default-charts.png](output/base-dashboard-batch-20261119/03-dashboard-default-charts.png)：`1440×900` 仪表盘 6 列栅格首屏：3 张 KPI 指标卡（记录总数 6、预算求和 420、已验收 50% 进度条）并排，下方柱状图与环形饼图对称排列。
- [04-dashboard-custom-persisted.png](output/base-dashboard-batch-20261119/04-dashboard-custom-persisted.png)：`1440×900` 新增自定义条形图「阶段预算排行条形图」并整页刷新后，从 PostgreSQL 持久还原折线趋势图、汇总明细表与自定义条形图。
- [05-mobile-dashboard.png](output/base-dashboard-batch-20261119/05-mobile-dashboard.png)：`390×844` 模拟移动视口下单列堆叠展示正常，页面级横向溢出为 `0px`。

## 已知边界

- 撤销栈暂未覆盖字段增删改与视图结构变更，仍以记录增删改与批量单元格写操作为主；分组视图拖选、日历小时级排程与甘特真实拖拽留作后续 P1 深化。
- 移动端核验基于 macOS 无头 Chrome `390×844` 模拟视口，真机触控与中文输入法组合输入仍待实机验收。
