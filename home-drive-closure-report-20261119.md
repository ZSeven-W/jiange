# 主页与云盘操作闭环（Home & Drive Operations Closure）验证报告（2026-11-19）

## 一、交付范围（P1 Slice 5）

本轮完成 **主页视图与交互闭环** 及 **云盘操作闭环** 全栈落地（PostgreSQL / Memory 完全对等）：

1. **云盘持久化快捷方式（`0075_drive_shortcuts.sql`）**：
   - [0075_drive_shortcuts.sql](server/internal/migrate/sql/0075_drive_shortcuts.sql)：新增 `drive_shortcuts` 表（关联 `workspaces(id)`、可选 `parent_id`、`personal` 范围、`target_node_id` 及创建者，独立于 `nodes` 树，不污染旧端 `nodes_kind_check` 与目录树触发器）。
   - [server/internal/store/drive-shortcuts.go](server/internal/store/drive-shortcuts.go) & [server/internal/api/drive-shortcuts.go](server/internal/api/drive-shortcuts.go)：实现 `GET/POST /api/drive/shortcuts` 与 `DELETE /api/drive/shortcuts/{sid}`（全链路 session guard 与 `X-Jiange-User-Id` 账号绑定）；列表读取时对每个 `target_node_id` 实时复验 `GetDoc` 访问权限，撤权或删除原文档后立即返回 `targetAccessible: false` 且不泄露任何目标元数据；移除快捷方式绝不影响原文档。

2. **多维表格/问卷完整副本 & 任意类型复制到指定目录**：
   - [server/internal/store/copy-base-survey.go](server/internal/store/copy-base-survey.go) & [server/internal/api/duplicate.go](server/internal/api/duplicate.go)：
     - 放开并实现 **多维表格（`base`）全量事务复制（`CopyBase`）**：完整克隆多数据表（`bt_tables`）、字段（主字段优先插入并重映射同 Base `target_table_id` 及 `link`/`lookup` 选项）、记录（重映射字段 ID 并克隆关联 `attachments` 附件行）、记录关联（`bt_links`）及共享视图配置（`RemapBaseViewConfig` 重映射筛选/排序/分组/隐藏/填色/卡片字段 ID，自动跳过个人视图）；当源表存在锁定权限视图时对非管理员返回 `403 copy_protected`，杜绝通过复制绕过权限视图。
     - 同步落地 **问卷（`survey`）事务复制（`CopySurvey`）**：复制题目结构与跳题规则为新草稿与新公开令牌，不拷贝旧答卷。
     - 修复 [postgres-copy.go](server/internal/store/postgres-copy.go) 与 [memory-copy.go](server/internal/store/memory-copy.go) 中 `CopyDoc` 复制到云盘文件夹时的工作空间锁、`drivePGDestination(..., RoleEdit)`、`drive_revision = 1` 与 `personal` 继承，并扩展 `duplicateInput` 支持显式 `parentId` 与 `personal` 范围，覆盖 `doc` / `board` / `sheet` / `base` / `slides` / `survey` 全部云文档类型复制到指定目录。
   - [server/internal/api/home-drive-closure_test.go](server/internal/api/home-drive-closure_test.go)：同时覆盖 Memory 与隔离 PostgreSQL 16 的多表 Base 复制（含跨表关联、附件重映射、视图配置重映射、个人视图隔离、权限视图 403 阻断）、文档/问卷复制到云盘文件夹，以及快捷方式创建/实时撤权隐藏/安全删除闭环。

3. **主页与云盘前端交互闭环**：
   - **主页**（[home.tsx](apps/web/src/pages/home.tsx)、[home-file-actions.ts](apps/web/src/pages/home-file-actions.ts)、[base-page.tsx](apps/web/src/pages/base-page.tsx)）：
     - 新增独立可折叠的「置顶文档」卡片区（`data-home-pins`），支持直达与悬停/触控取消置顶。
     - 新增列表与卡片视图批量勾选与飞书蓝色批量操作栏（`data-home-batch`：全选/半选、批量收藏、批量置顶、账号与修订号校验的批量删除、取消选择）。
     - 主页「更多操作」菜单及多维表格页顶栏开放多维表格与问卷「创建副本」入口。
   - **云盘**（[drive-page.tsx](apps/web/src/pages/drive-page.tsx)、[api.ts](apps/web/src/lib/api.ts)）：
     - 启用顶部「添加」快捷方式卡片与可搜索添加弹窗（`AddShortcutDialog`），在目录中呈现带角标的快捷方式卡片（`data-drive-shortcuts`），无权/已删目标自动置灰并支持移除。
     - 条目菜单新增「复制到…」（`CopyToDialog`，支持跨「我的文件夹 / 共享文件夹」浏览嵌套目录并复制到指定位置）。
     - 列表行、网格卡片与文件夹支持 HTML5 拖拽移动到任意文件夹卡片或面包屑祖先目录（支持多选批量拖拽，走 guarded `moveForAccount`）。
     - 网格视图全面补齐卡片勾选框与顶部共用批量操作工具栏（`data-drive-batch`）。

---

## 二、自动化与端到端验证结果

| 验证项 | 命令 / 路径 | 结果 |
| --- | --- | --- |
| Go 全量测试（Memory + 全部包） | `cd server && go test ./...` | 通过 |
| Go 隔离 PostgreSQL 16 + `-race` 集成测试（含 `TestHomeDriveClosurePostgres`、`TestPostgresDuplicate*`、`TestPostgresCopyDocAtomic`、`migrate`） | `JIANGE_TEST_DATABASE_URL=... go test -race ...` | 通过 |
| 全仓库类型检查 | `pnpm typecheck` | 通过（7/7 包） |
| 前端生产构建 | `pnpm --filter @jiange/web build` | 通过 |
| 全仓库前端/SDK 单元测试（含 `home-drive-closure.test.tsx`、`home-file-actions.test.ts`、`i18n.test.ts`） | `pnpm test` | 通过（240 文件，1,327 用例） |
| 真实 Postgres 16 + Go + Vite + Headless Chrome CDP 端到端验证 | `node scripts/verify-home-drive-closure.mjs` | 通过（0 控制台错误；实库 `drive_shortcuts` 与目标目录 `nodes` 落盘正常） |

### CDP 截图人工核验（桌面 `1440×900` 与模拟手机 `390×844`）
- `output/home-drive-closure-20261119/01-home-pins-and-batch.png`：主页展示独立「置顶文档 2」卡片区及列表批量勾选工具栏（`已选择 2 项` + 收藏/置顶/删除/取消选择），并验证直接从主页为多维表格创建副本。
- `output/home-drive-closure-20261119/02-drive-shortcuts-and-grid-batch.png`：云盘启用顶部「添加」快捷方式入口并展示「快捷方式 1」卡片，网格视图支持卡片批量勾选与顶部批量操作栏。
- `output/home-drive-closure-20261119/03-drive-folder-copy-and-drop.png`：进入目标文件夹「研发档案」，确认通过「复制到…」创建的多表多维表格副本（`项目台账 副本`，保留 2 张数据表）与拖拽移入的电子表格（`财务预算表`）均已持久化落地。
- `output/home-drive-closure-20261119/04-home-mobile.png` & `05-drive-mobile.png`：`390×844` 模拟移动端下主页置顶卡片、云盘 2×2 顶部入口与快捷方式卡片排版清晰，无横向溢出或操作遮挡。

### 已知边界与后续计划
- 主页卡片内容实时正文缩略图渲染与定时后台孤儿附件对象扫描任务（当前永久删除 `PurgeDriveNode` 已支持即时释放最后引用 Blob）留作后续增强。
