# 多维表格日历小时排程、甘特真实拖拽排期与字段/视图结构级撤销验证报告（2026-11-20）

## 1. 目标与范围（P1 深化 Slice 18）

针对 [feishu-gap-audit-20261118.md](feishu-gap-audit-20261118.md)「多维表格（Base）→ 视图、公式与批量操作细节」中的既有深化项，本轮完整落地三大闭环能力：

1. **后端分钟级日期时间支持、`endField` 视图配置与原子字段无损恢复（PostgreSQL 16 + Memory 对等）**
   - [server/internal/store/base-compare.go](server/internal/store/base-compare.go)、[server/internal/api/base.go](server/internal/api/base.go)：新增共享校验函数 `ValidBaseDateValue`，在保持既有民用日期 `"YYYY-MM-DD"` 严格语义不变（继续拒绝 ISO 时区串与非法日期）的前提下，支持分钟级本地墙上时间 `"YYYY-MM-DD HH:mm"`，打通 `validCell`、类型转换与并发安全 CAS 接口 `CompareDateCells`。
   - [server/internal/btquery/btquery.go](server/internal/btquery/btquery.go)、[server/internal/store/base-field-guarded.go](server/internal/store/base-field-guarded.go)：为 `btquery.Config` 增加 `EndField *int64`（`json:"endField,omitempty"`）字段存在性校验与权限视图删除保护，并复用副本字段重映射。
   - [server/internal/store/base-field-restore.go](server/internal/store/base-field-restore.go)、[server/internal/store/base-batch.go](server/internal/store/base-batch.go)、[server/internal/api/base-batch.go](server/internal/api/base-batch.go)、[server/internal/api/api.go](server/internal/api/api.go)：新增 `POST /api/bases/{id}/fields/restore`（`RestoreFieldGuarded`，PG 与 Memory 事务对等），在单事务内原位重建已删除字段并批量无损写回所有捕获的非空单元格值（严格校验 `RoleEdit`、`!writeRestricted`、主字段位置禁越、单元格类型校验，自动跳过已独立删除的记录并广播实时重载事件）。

2. **日历视图小时排程闭环（`apps/web/src/pages/base/calendar-view.tsx`）**
   - 保留既有月视图全天/日程排布与全部纯函数契约，新增 `calendarDateTime`、`calendarTimedSpan`、`layoutDayTimedEvents`、`formatCalendarDateTime`。
   - 周视图（`周`）与日视图（`日`）升级为完整 **24 小时时间轴网格（`00:00–23:00`，默认定位 `08:00`）**：
     - 顶部吸顶「全天」带与 24 小时时段带自由互拖（全天 ↔ 小时排程互转）；
     - 点击空白小时格（`data-calendar-slot`）即时在对应时刻创建带起止时间的新排程；
     - 定时日程卡片（`data-calendar-timed-event`）支持重叠日程自动并列分栏、当前时间红线、真实指针跨时段/跨天 30 分钟步进拖拽平移，以及底部拖拽手柄（`data-calendar-event-resize`）调整日程时长；
     - 所有创建、平移与调时长操作走服务端 CAS 并自动压入 `BaseUndoStack` 支持一键撤销/重做。
   - 工具栏新增开始/结束日期字段选择器（`cfg.group` + `cfg.endField`），表格单元格编辑器（`cells.tsx` / `registry.ts`）同步支持 `YYYY-MM-DD HH:mm` 展示与 `datetime-local` 编辑。

3. **甘特图真实指针拖拽平移、左右边缘拉伸与多刻度缩放（`apps/web/src/pages/base/gantt.tsx`）**
   - 新增纯函数 `resizeGanttRange`，兼容全天日期与分钟级日期时间（平移/拉伸时保留原 `HH:mm` 时分部分）。
   - 任务条（`data-gantt-bar`）支持实时指针拖拽平移，两侧新增左右拉伸手柄（`data-gantt-resize-left` / `data-gantt-resize-right`）独立调整开始与结束日期；拖动过程中实时更新任务条宽度与位置并弹出悬浮起止日期与天数提示，松手后通过 `compareCells` 服务端 CAS 提交并接入 `BaseUndoStack`。
   - 新增 `月 / 双月 / 季度` 三档时间刻度切换与今日列高亮；保留 HTML5 拖拽回退兼容。

4. **字段与视图结构级撤销/重做闭环（`undo.ts`、`grid.tsx`、`view-tabs.tsx`、`base-page.tsx`）**
   - 扩展 `BaseUndoStack` 与 `UndoApi` 支持 9 类结构级变更及撤销→重做 ID 自动重映射：
     - 字段级：新增字段、编辑字段属性、调整列顺序、删除字段（调用 `/fields/restore` 无损恢复列定义与整列数据）；
     - 视图级：新建/复制视图、重命名视图、保存视图配置、调整视图顺序、删除视图（原位恢复 `pos`、`config` 与个人/共享属性并自动切回）。
   - 在 `BasePage` 补齐非表格视图（日历/甘特/看板/画廊）全局 `⌘/Ctrl+Z` 与 `⌘/Ctrl+Shift+Z` 快捷键支持；补齐 30 条新增中英文词条（`apps/web/src/i18n/en.ts`）。

---

## 2. 自动化测试与构建验证

| 检查项 | 命令 | 结果 |
| --- | --- | --- |
| Go 全量单测（含新增 `TestMemoryBaseHourlyDateAndFieldRestore`、`TestMemoryBaseScheduleUndoAPI`） | `cd server && go test -count=1 ./...` | **PASS**（全部 Go 包通过） |
| PostgreSQL 16 集成测试（日期时间 CAS + 字段无损恢复 Store & HTTP API） | `JIANGE_TEST_DATABASE_URL=... go test -v -count=1 -run 'TestPostgresBaseHourlyDateAndFieldRestore\|TestPostgresBaseScheduleUndoAPI\|TestPostgresCompareDateCells' ./internal/store ./internal/api` | **PASS**（`TestPostgresCompareDateCells` 1.09s、`TestPostgresBaseHourlyDateAndFieldRestore` 0.71s、`TestPostgresBaseScheduleUndoAPI` 1.38s） |
| 全仓 TypeScript 类型检查 | `pnpm typecheck` | **PASS**（7 个 workspace 项目全部通过） |
| Web 生产构建 | `pnpm --filter @jiange/web build` | **PASS** |
| 前端单元测试（含新增 `calendar.test.tsx`、`gantt.test.tsx`、`undo.test.ts` 与 `i18n.test.ts`） | `pnpm test` | **PASS**（250 个测试文件，1376 条用例全部通过） |
| Headless SDK 打包校验 | `pnpm test:sdk:pack` | **PASS** |
| 文件命名规范校验 | `pnpm lint:names` | **PASS**（0 违规） |

---

## 3. 真实 PostgreSQL 16 + 编译后 Go 服务 + Headless Chrome 端到端验证

运行 [scripts/verify-base-schedule-undo.mjs](scripts/verify-base-schedule-undo.mjs)（临时 PostgreSQL 16 容器 `jiange-pg-slice18` + 编译后 Go 服务 `127.0.0.1:8080` + Vite `127.0.0.1:5174` + Headless Chrome CDP `127.0.0.1:9228`），实测完整用户链路：

1. **字段删除无损撤销/重做**：在表格视图删除「负责人备注」列（含 `架构组全员`、`API 验收`、`发布负责人` 三行单元格），点击顶栏撤销按钮验证列定义与整列单元格值完整恢复，再点击重做删除与二次撤销恢复均正常。
2. **视图重命名撤销**：通过视图菜单将「小时排程日历」重命名为「研发排程日历」，点击撤销按钮验证名称还原为「小时排程日历」。
3. **日历小时排程**：切换至「小时排程日历 → 周视图」，通过真实指针拖拽将 `架构评审会 (09:00–10:30)` 向下平移 2 小时至 `11:00–12:30`，再拖拽底边手柄拉长 1 小时至 `11:00–13:30`；点击 `16:00` 空白时段新建 `16:00–17:00` 日程后通过撤销按钮原子撤回。
4. **甘特图真实拖拽与边缘拉伸**：切换至「项目甘特图」，拖拽 `版本灰度排期 (10–16)` 右侧手柄延后 3 天至 `10–19`，再拖拽任务条整体前移 2 天至 `08–17`，随后点击撤销还原为 `10–19`。
5. **整页刷新持久化与移动端验证**：执行 `Page.reload` 确认字段恢复结果、日历小时排程 (`11:00–13:30`) 与甘特拉伸结果 (`10–19`) 全部在 PostgreSQL 16 持久保留；人工检查桌面 `1440×900` 与移动端 `390×844` 全部 4 张截图，确认布局清晰、横向溢出均为 `0px`、`consoleErrors = 0`、`pageErrors = 0`。

---

## 4. 遗留边界与后续演进方向

- 表格分组视图下的跨组拖选与移动端真机触摸长按手势优化留作后续交互深化。
- 双向关联字段（`link`）删除与破坏性字段类型转换（如 `text → number` 导致不可逆丢值）当前不进入自动字段撤销栈，以保障跨表关联引用完整性。
