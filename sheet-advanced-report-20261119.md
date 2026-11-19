# 普通电子表格高级分析、保护区域与单元格锚点评论验证报告（2026-11-19）

本轮推进 **P1 Slice 6（普通电子表格高级分析、保护区域与单元格锚点评论）**，在既有独立电子表格工作簿（`kind="sheet"`、`#/sheet/{id}`）基础上，补齐飞书表格核心分析与协同管控闭环：单元格数据验证与行内下拉选择器、基于公式求值结果动态渲染的条件格式、管理员专属受保护区域权限控制，以及绑定持久化行列 ID 的单元格锚点评论与权限策略同步。

## 主要改动

### 1. 数据库迁移与服务端存储层（PostgreSQL + Memory 对等）

- [0076_sheet_rules_and_comments.sql](server/internal/migrate/sql/0076_sheet_rules_and_comments.sql)：
  - 为 `sheet_worksheets` 新增 `validations`、`conditional_formats`、`protected_ranges` 三个 `jsonb NOT NULL DEFAULT '[]'::jsonb` 列。
  - 新增 `sheet_comments` 表，外键绑定 `(node_id, worksheet_id, row_id, column_id)` 并开启 `ON DELETE CASCADE`（行列删除或工作表删除时自动级联清理），建立 `idx_sheet_comments_node_ws` 索引。
- [sheets-rules.go](server/internal/store/sheets-rules.go)：
  - 定义 `SheetDataValidation`（`list` / `number` / `date`、`strict`、`hint`）、`SheetConditionalFormat`（10 类运算符 `gt`/`gte`/`lt`/`lte`/`eq`/`neq`/`between`/`contains`/`empty`/`not_empty` + `bg`/`color`/`bold`）、`SheetProtectedRange`（坐标矩形、`description`、`allowedUserIds`）与 `ErrSheetValidation`。
  - 实现前后端一致的规则校验归一化、单元格写入校验（允许空值清空与 `=` 公式，严格规则拦截非法字面量）、受保护区域写入及删除行列拦截，以及插入/删除行列时的规则坐标自动平移。
- [sheet-comments.go](server/internal/store/sheet-comments.go)：
  - 新增 `SheetCommentStore` 接口并嵌入 `Store`（[store.go](server/internal/store/store.go)），完成 PostgreSQL 与 Memory 双引擎对等实现（`ListSheetComments`、`CreateSheetComment`、`UpdateSheetComment`、`DeleteSheetComment`）。
  - 严格校验 `DocumentCommentAllowed`（与 `nodes.comment_min_role` 联动）、仅作者可编辑评论正文、协作者可解决/重新打开、仅作者或管理员可删除。
- [sheets.go](server/internal/store/sheets.go)、[sheets-memory.go](server/internal/store/sheets-memory.go)、[sheets-pg.go](server/internal/store/sheets-pg.go)、[memory.go](server/internal/store/memory.go)：
  - `WriteSheetCells` 服务端强制执行 `protected_ranges` 写拦截（`ErrForbidden`）与严格 `validations` 校验（`ErrSheetValidation`）。
  - `UpdateWorksheetMeta` 强制仅 `manage` 角色可修改 `protectedRanges`（非管理员返回 `ErrForbidden`）。
  - `MutateSheetAxis` 在删除行列前校验受保护区域交叉拦截，并在增删行列后同步平移三类规则坐标，Memory 与 Postgres 同步级联清理被删行列上的评论。
  - `CopySheetWorkbook` 事务复制工作簿时完整克隆 `validations`、`conditional_formats` 与 `protected_ranges`。
- 表格评论权限策略统一：
  - [docs.go](server/internal/store/docs.go) 新增 `DocumentCommentAllowed`；[share-guarded.go](server/internal/store/share-guarded.go) 与 [docs.go](server/internal/api/docs.go) 开放 `kind="sheet"` 的 `commentMinRole`（`view`/`edit`）设置；[drive-folder.go](server/internal/store/drive-folder.go)、[wiki-memory.go](server/internal/store/wiki-memory.go)、[sheets-memory.go](server/internal/store/sheets-memory.go) 补齐 Memory 新建/复制表格默认 `view` 策略与 Postgres 一致；[share-dialog.tsx](apps/web/src/components/share-dialog.tsx) 在表格分享权限面板放开「谁可以评论」配置项。

### 2. HTTP REST 接口与实时通知

- [sheets.go](server/internal/api/sheets.go)：`POST /api/sheets/{id}/cells` 将 `store.ErrSheetValidation` 映射为 `HTTP 422`（`error: "validation_failed"`）。
- [sheet-comments.go](server/internal/api/sheet-comments.go) 与 [api.go](server/internal/api/api.go)：新增 4 个受 `sheetRequestGuard`（账号绑定 + 协议版本头）保护的端点，并在变更后通过 `SheetHub.Notify` 实时触发在线协作者刷新评论：
  - `GET /api/sheets/{id}/comments?worksheetId=...`
  - `POST /api/sheets/{id}/comments`
  - `PATCH /api/sheets/{id}/comments/{cid}`
  - `DELETE /api/sheets/{id}/comments/{cid}`

### 3. 前端规则引擎、侧边抽屉与网格集成

- [api.ts](apps/web/src/lib/api.ts)：补充 `SheetDataValidation`、`SheetConditionalFormat`、`SheetProtectedRange`、`SheetComment` 类型及 `sheetsApi` 评论 CRUD 方法。
- [sheet-rules.ts](apps/web/src/pages/sheet/sheet-rules.ts) & [sheet-rules.test.ts](apps/web/src/pages/sheet/sheet-rules.test.ts)：实现客户端实时条件格式求值（直接基于 `EvalValue`，支持公式结果动态变色）、数据验证评估、下拉规则查找、保护区域判定及 5 套飞书风格预设配色。
- [sheet-panels.tsx](apps/web/src/pages/sheet/sheet-panels.tsx)：实现响应式右侧抽屉（桌面端 `w-80` 停靠、移动端 `<sm` 浮层无溢出），支持四标签切换（`验证` / `条件` / `保护` / `评论`）、点击规则 A1 区域跳转选区、管理员按协作者列表勾选保护白名单、按「全部 / 当前单元格」及「已解决」筛选评论线程。
- [sheet-toolbar.tsx](apps/web/src/pages/sheet/sheet-toolbar.tsx) & [sheet-page.tsx](apps/web/src/pages/sheet/sheet-page.tsx)：
  - 工具栏新增 `数据验证`、`条件格式`、`保护区域`、`评论`（带未解决橘色角标计数）入口。
  - 网格单元格集成行内下拉选择按钮（`▾`）与选项弹窗、动态条件格式背景/文字/加粗渲染、严格验证客户端预检与服务端 `422` 提示、非严格验证红色角标提示、受保护区域锁定提示与编辑拦截、以及飞书风格右上角橘色评论三角角标（点击直接定位单元格并展开评论抽屉）。
  - WebSocket 收到修订通知时同步刷新工作簿与评论缓存；[en.ts](apps/web/src/i18n/en.ts) 补全所有新增英文词条并通过完整性测试。

## 测试结果

1. **后端全量与隔离 PostgreSQL 16 `-race` 集成测试**：
   - `cd server && go test -count=1 ./...`：全部 15 个 Go 包无缓存通过。
   - 隔离 `postgres:16-alpine` 容器执行：
     - `JIANGE_TEST_DATABASE_URL=... go test -race ./internal/api -run "TestSheetAdvanced|TestSheetAPILifecycleAndSecurity" -v`：`TestSheetAdvancedMemory`（0.04s）、`TestSheetAdvancedPostgres`（1.25s）、`TestSheetAPILifecycleAndSecurity`（0.01s）全通过，覆盖严格/警告校验（`list`/`number`/`date`）、条件格式坐标随增删行列平移、受保护区域防改格/防删行/防删列与白名单放行、评论锚定抗插行与删行级联清理、`commentMinRole="edit"` 权限拦截及工作簿副本规则克隆。
     - `JIANGE_TEST_DATABASE_URL=... go test -race ./internal/store -run "Sheet" -v`：`TestMemorySheetStore` 与 `TestPostgresSheetStore` 全通过。
     - `JIANGE_TEST_DATABASE_URL=... go test ./internal/migrate -v`：含 `0076_sheet_rules_and_comments.sql` 迁移顺序与并发测试全通过。
2. **前端类型检查、构建、单测与 SDK 校验**：
   - `pnpm typecheck`：7 个 workspace 项目全部通过。
   - `pnpm --filter @jiange/web build`：生产包编译通过。
   - `pnpm test`：**241 个测试文件 / 1,332 项测试全部通过**（含新增 [sheet-rules.test.ts](apps/web/src/pages/sheet/sheet-rules.test.ts) 与扩展后的 [sheet-page.test.tsx](apps/web/src/pages/sheet/sheet-page.test.tsx)、`i18n.test.ts`）。
   - `pnpm test:sdk:pack` 与 `pnpm lint:names`（2,468 条路径）全部通过。

## 真实环境与 Chrome CDP 端到端可视化验证

在隔离 `postgres:16-alpine` 容器 + 编译版 Go 服务（`:8080`）+ Vite（`:5174`）+ 无头 Chrome CDP（`:9234`）下执行 [verify-sheet-advanced.mjs](scripts/verify-sheet-advanced.mjs)，全部断言通过且控制台 0 报错，并完成 5 张截图逐张视觉审查：

- [01-validation-dropdown.png](output/sheet-advanced-20261119/01-validation-dropdown.png)：`1440×900` 桌面端为 `D2:D4` 添加严格下拉验证，展开 `D2` 行内下拉菜单选择 `已完成` 并确认服务端 `422 validation_failed` 拦截非法输入。
- [02-conditional-formatting.png](output/sheet-advanced-20261119/02-conditional-formatting.png)：`1440×900` 为 `C2:C5` 配置 `> 100` 浅绿达标（同时命中数值格 `C2=120` 与公式格 `C5=SUM(C2:C4)=250`）以及 `D2:D4` 配置 `= 已延期` 浅红预警。
- [03-protected-range.png](output/sheet-advanced-20261119/03-protected-range.png)：`1440×900` 管理员将 `A5:E5` 设为保护区域，面板自动拉取协作者白名单候选项，网格聚焦态展示锁定角标。
- [04-cell-comments.png](output/sheet-advanced-20261119/04-cell-comments.png)：`1440×900` 在公式单元格 `C5` 添加单元格锚点评论，展示右上角橘色评论三角、工具栏未解决计数 `1`、公式引用 `#ff8800` 高亮与条件格式叠加渲染，并验证解决/重开切换及普通编辑者访问 `C5` 在 API（`403`）与前端均被拦截。
- [05-mobile-sheet-panel.png](output/sheet-advanced-20261119/05-mobile-sheet-panel.png)：`390×844` 模拟移动视口下评论抽屉浮层展示正常，页面级横向溢出为 `0px`，协作者按权限展示解决按钮并隐藏非本人删除入口。

## 已知边界与后续方向

- **尚未涵盖的高级电子表格分析能力**：嵌入式图表（柱状图/折线图/饼图）、数据透视表、自定义公式条件格式、以及 `.xlsx` 导出/导入对条件格式、数据验证、列宽/行高、主题色、渐变填充与复杂边框的完整保真仍留作后续扩展。
- **搜索索引**：表格单元格检索仍为工作簿内顺序扫描（未引入 `pg_trgm` 扩展索引）。
- **端侧核验**：本轮移动端验证基于 macOS 无头 Chrome `390×844` 模拟视口，真机 iOS/Android 触控与中文 IME 输入法组合输入仍待实体设备核验。
