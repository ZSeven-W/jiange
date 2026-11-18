# 画板文档子类型与列表筛选对齐验证（2026-11-18）

在服务端 `0051_doc_type.sql` 与 `DocType="board"` 字段基础上，打通画板文档子类型的原子写入、副本与改名投影以及全端界面识别，使其与普通文档在主页、云盘、侧栏、全局搜索、回收站及文档顶栏保持一致区分。

## 主要改动

- **服务端事务原子性与投影修复**：
  - `server/internal/store/doc-type.go`、`postgres-docs.go`、`memory-docs.go`、`drive-folder.go`：新增 `CreateDocWithType` 与 `CreateDriveNodeWithType`，在创建事务内一次性写入 `doc_type`，避免创建与打标之间出现无类型文档；当 `docType == ""` 时保持兼容旧迁移升级路径的插入列集。
  - 修复 `driveMemoryEntry` 与 `Postgres.RenameDriveNode` 漏传/漏返回 `doc_type` 的问题。
  - `server/internal/store/postgres-copy.go`、`memory-copy.go` 与 `server/internal/api/duplicate.go`：在 `CopyDoc` 事务内原子继承源文档 `doc_type`，无标题画板创建副本时默认命名为「未命名画板 副本」。
- **前端子类型识别、筛选与图标对齐**：
  - `apps/web/src/lib/api.ts`：`DocMeta`、`DriveEntry` 及创建接口支持传递 `docType: "board"`。
  - `apps/web/src/components/sidebar.tsx` 与 `apps/web/src/i18n/en.ts`：新增 `isBoardDoc` 判定，侧栏树/置顶/共享及 `docTitle` 展示画板图标与「未命名画板」默认标题（含英文词条 `"Untitled Whiteboard"`）。
  - `apps/web/src/pages/home.tsx` 与 `home-view.ts`：主页「新建 → 画板」走账号绑定 `createWordImportNode(..., "board")`；类型筛选新增「画板」并把画板与普通文档分开过滤；列表/卡片展示绿色 `WhiteboardIcon`。
  - `apps/web/src/pages/drive-page.tsx`：云盘新建菜单及文件列表/网格展示 `WhiteboardIcon`，新建画板原子传递 `docType: "board"`。
  - `apps/web/src/components/global-search.tsx`：高级搜索新增「画板」筛选并区分普通文档，结果项渲染画板图标与默认标题。
  - `apps/web/src/pages/trash.tsx` 与 `doc-page.tsx`：回收站展示画板图标与「画板」标签（并顺带修复幻灯片/文件在回收站的图标与标签）；文档顶栏与面包屑使用画板图标与默认标题。

## 浏览器截图与端到端验证

在隔离 PostgreSQL（`postgres:16-alpine` 临时容器）与本地无头 Chrome（CDP）中运行 [验证脚本](scripts/verify-board-document-subtype.mjs)：

- [桌面端：主页卡片与侧栏区分画板与普通文档图标](jiange-board-subtype-home-desktop-20261118.png)
- [模拟移动端（390 × 844）：全局搜索高级筛选「画板」](jiange-board-subtype-filter-mobile-20261118.png)
- [桌面端：回收站画板图标与「画板」标签及侧栏副本](jiange-board-subtype-drive-trash-20261118.png)

端到端覆盖：主页新建画板自动进入全屏画板编辑器并校验 `docType === "board"` 与顶栏图标；主页列表/卡片对比普通文档并切换「画板/文档」类型筛选；全局搜索「画板」筛选及 390 × 844 窄屏展示；主页创建副本生成「未命名画板 副本」且保留 `docType === "board"`；云盘新建画板、改名、移入回收站查看标签并还原。

## 测试结果

- Go 单测与跨语言/store/api 回归：`cd server && go test ./...` 全量通过；包含 `TestMemoryDocType`、`TestPostgresDocType`（隔离 schema + `-race`）、`TestDocTypeBoardLifecycle`（`-race`）以及历史迁移兼容性测试 `TestPostgresLegacySharesRemainExplicitAfterMigration`、`TestPostgresCreateShareOnceAndAnonymousLink`。
- 真实 PostgreSQL 全包集成测试：`JIANGE_TEST_DATABASE_URL=... go test ./internal/store ./internal/api` 全量通过。
- 前端与 SDK 验证：`pnpm test`（其中 `@jiange/web` 226 个测试文件、1284 项测试全部通过，含新增 [board-subtype.test.tsx](apps/web/src/pages/board-subtype.test.tsx) 与 `i18n.test.ts`）、`pnpm typecheck`、`pnpm test:sdk:pack` 与 `pnpm --filter @jiange/web build` 全部通过。

## 已知边界

- `画板` 在存储层仍作为 `kind='doc', doc_type='board'` 复用文档内的 `flowchart` 块，尚未拆分为独立画布 CRDT 协同协议；思维导图入口仍沿用独立种子结构而非 `board` 子类型。
- 画板内对象/坐标级锚点评论、多选笔迹等比缩放、真实移动设备触控笔迹以及与登录态飞书实页的逐像素比对仍未完成。
