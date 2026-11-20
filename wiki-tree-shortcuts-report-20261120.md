# 独立知识库空间（Wiki）目录树拖拽排序与跨库/云盘快捷方式引用验证报告（2026-11-20）

## 1. 交付范围（P1 Slice 11）

本轮针对 [feishu-gap-audit-20261118.md](feishu-gap-audit-20261118.md)「主页、云盘、全局搜索与知识库」中 **独立知识库空间（Wiki）** 剩余的 P1 缺口——**目录树拖拽排序** 与 **跨库/云盘快捷方式引用**——落地完整前后端与 PostgreSQL 持久层闭环：

1. **数据库迁移与 PG / Memory 对等存储层**
   - `server/internal/migrate/sql/0078_wiki_shortcuts.sql`：新增持久化 `wiki_shortcuts` 表（`id`、`workspace_id`、`wiki_space_id`、`parent_id`、`target_node_id`、`title`、`sort_key`、`creator_id`、`created_at`、`updated_at`）及按空间与目标节点查询的索引 `wiki_shortcuts_space_idx`、`wiki_shortcuts_target_idx`。
   - `server/internal/store/wiki.go`、`wiki-pg.go`、`wiki-memory.go`、`memory-docs.go`：为 `WikiNodeEntry` 补齐 `sortKey`，为 `WikiSpaceDetail` 补齐 `shortcuts`，并统一使用单调递增的 `"w%08d"` 排序键（兼容历史 `'V'` 节点并保证新建/迁入节点顺序追加在末尾）；`GetWikiSpaceDetail` 按 `sort_key, id` 稳定输出目录树并过滤父节点不可见/已删除的孤儿快捷方式。
   - `server/internal/store/wiki-tree-shortcuts-pg.go`、`wiki-tree-shortcuts-memory.go`：实现 PG 与 Memory 行为完全对等的 3 个核心原子方法：
     - `ReorderWikiNodeGuarded`：校验 `position >= 0`、`expectedRevision` 乐观锁（过期返回 `ErrConflict`）、同父排序（需节点及目标父节点/空间 `RoleEdit`）与跨父移动（需节点 `RoleManage`、目标父节点/空间 `RoleEdit` 并刷新整棵子树权限修订号）、防止循环嵌套及文件夹移入非文件夹页面，并在事务内将目标兄弟节点重平衡为 `"w00000010"`、`"w00000020"`… 消除排序键精度退化。
     - `CreateWikiShortcutGuarded`：校验目标父目录/空间 `RoleEdit` 与目标资源实时 `RoleView` 权限（支持引用其他知识库节点、同空间节点或云盘任意类型资源），拦截自我引用及同父目录重复引用（`ErrConflict`）。
     - `DeleteWikiShortcutGuarded`：允许快捷方式创建者、空间管理员或父目录编辑者移除快捷方式。

2. **REST API 与零元数据泄露的实时权限复验**
   - `server/internal/api/api.go`、`server/internal/api/wiki.go`：新增 `POST /api/wiki/spaces/{spaceId}/nodes/{id}/reorder`、`POST /api/wiki/spaces/{spaceId}/shortcuts` 与 `DELETE /api/wiki/spaces/{spaceId}/shortcuts/{sid}`。
   - `enrichWikiShortcut` 在每次 `GET /api/wiki/spaces/{spaceId}` 与创建快捷方式返回时对每条快捷方式实时调用 `s.Store.GetDoc(ctx, userID, sc.TargetNodeID)`：若调用者无权访问目标资源或目标已删除，则将 `targetAccessible` 置为 `false` 并清空 `title`、`targetTitle`、`targetKind`、`targetDocType`、`targetIcon`、`targetWikiSpaceId` 与 `targetWikiSpaceName`，避免私有知识库页面标题或别名通过快捷方式泄露给无权限成员。

3. **前端目录树三区拖拽排序、快捷方式弹窗与多视图渲染**
   - `apps/web/src/lib/api.ts`：补齐 `WikiNodeEntry.sortKey`、`WikiShortcut`、`WikiSpaceDetail.shortcuts` 及 `wikiApi.reorderNode` / `createShortcut` / `deleteShortcut`。
   - `apps/web/src/pages/wiki/wiki-tree-dnd.ts`（含单测 `wiki-tree-dnd.test.ts`）：纯函数实现三区落点判定（`before` / `inside` / `after`）、子孙节点循环校验、同父 vs 跨父权限校验、同父重排下标补偿计算与「上移 / 下移」步进计划。
   - `apps/web/src/pages/wiki/wiki-shortcut-dialog.tsx`：新增「添加快捷方式」弹窗（`data-wiki-shortcut-dialog`），支持在「其他知识库」与「云盘与文档」标签间切换、选择来源空间、实时关键词过滤、指定挂载父目录与自定义显示别名。
   - `apps/web/src/pages/wiki/wiki-space-page.tsx`：
     - 可编辑目录树节点全面支持 HTML5 拖拽排序与 3 态视觉指示（`before` 顶部 2px 指示线、`inside` 高亮框、`after` 底部 2px 指示线），附带拖拽手柄与右键/更多菜单中的「上移」「下移」「添加快捷方式」操作，兼顾键鼠与移动端。
     - 目录树、知识库概览页与文件夹视图统一展示快捷方式：可访问快捷方式附带链接角标与来源徽章（目标知识库名称或「云盘」），点击平滑跳转至对应知识库页面或云盘文档/电子表格/多维表格/幻灯片/问卷；无权访问或已删除快捷方式展示只读锁定态（`无权访问或已删除` / `已失效`），授权用户可直接移除。
     - 顺带补齐知识库内 `kind="survey"` 节点直接渲染 `SurveyPage`。
   - `apps/web/src/i18n/en.ts` 与 `apps/web/src/pages/wiki/wiki-page.test.tsx`：补齐全部新增界面词条英文翻译与快捷方式/锁定态组件单元测试。

---

## 2. 自动化与实库验证结果

### 2.1 后端单元测试与 PostgreSQL 16 `-race` 集成测试
- 全量 Go 单元测试：`cd server && go test -count=1 ./...` —— **17 个测试包全部通过**。
- 真实 PostgreSQL 16（`postgres:16-alpine`，独立临时 schema）竞态集成测试：
  - `TestPostgresWikiSpaces` —— **PASS**（2.36s）。
  - `TestWikiTreeShortcutsPostgres`（[server/internal/api/wiki-tree-shortcuts_test.go](server/internal/api/wiki-tree-shortcuts_test.go)，Memory 与 PG16 双栈覆盖同父/跨父拖拽重排、乐观锁冲突 `409`、循环嵌套与文件夹下沉至页面拦截、编辑/只读 ACL 校验、跨库与云盘快捷方式创建、重复引用拦截、私有空间快捷方式对无权限成员的零泄露脱敏与快捷方式删除）—— **PASS**（4.28s）。
  - `internal/migrate`（含 `0078_wiki_shortcuts.sql`）—— **PASS**（4.689s）。

### 2.2 前端类型检查、构建、单元测试与 SDK 打包检查
- `pnpm typecheck` —— **PASS**（全工作区 7 个工程零错误）。
- `pnpm --filter @jiange/web build` —— **PASS**（Vite 生产构建 4,075 个模块通过）。
- `pnpm test` —— **PASS**（`@jiange/web` **245 个测试文件 / 1,349 条用例** + 全部无头 SDK 与 `@jiange/doc-sdk` 测试全部通过）。
- `pnpm test:sdk:pack` —— **PASS**（5 个打包无头 SDK 与 `@jiange/ooxml` 通过 Node ESM 与 NodeNext 校验）。
- `pnpm lint:names` —— **PASS**（全部跟踪路径符合 kebab-case 规范）。

### 2.3 真实 PostgreSQL 16 + 编译态 Go 服务 + Vite + Headless Chrome CDP 端到端验证
运行脚本：[scripts/verify-wiki-tree-shortcuts.mjs](scripts/verify-wiki-tree-shortcuts.mjs)（真实 `postgres:16-alpine` + 编译态 Go 二进制 + Vite `:5174` + Headless Chrome CDP `:9239`）：

- **三区拖拽排序与层级嵌套**：在空间 `研发架构知识库` 中，将 `C：存储与分片方案` 拖至 `A：系统总览` 之前（`before`），目录顺序立即更新为 `[C, A, B, F]`；随后将 `B：API 网关规范` 拖入 `C：存储与分片方案` 内部（`inside`），`B` 成为 `C` 的缩进子页面。
- **跨知识库 & 云盘快捷方式创建与跳转**：通过「添加快捷方式」弹窗在根目录创建指向 `产品设计中心` 的跨库快捷方式（别名 `跨库：设计语言规范`），并在文件夹 `F：运维发布手册` 下创建指向云盘电子表格的快捷方式（`云盘季度排期表` / 来源徽章 `云盘`）；点击跨库快捷方式平滑跳转至 `#/wiki/{spaceB}/node/{designDoc}` 并展示目标空间正文。
- **整页刷新持久化核验**：返回 `研发架构知识库` 并执行忽略缓存整页重载（`Page.reload`），拖拽后的树顺序与快捷方式全部从 PostgreSQL 16 完整还原。
- **实时权限隔离（零标题泄露）**：切换至仅属于工作区、无权访问私有知识库 `高管机密战略库` 的成员 `王产品` 并重载页面，其可正常查看重排后的目录树与 `跨库：设计语言规范`，而指向私有页面的快捷方式在 DOM 中仅渲染锁定占位（`无权访问或已删除`），页面文本不包含原标题或别名（`leaked: false`），且不显示「新建」「空间设置」等管理入口。
- **视觉截图人工核验（桌面 `1440×900` & 移动端 `390×844`）**：
  - 人工逐张核验 3 张 CDP 截图（所有者桌面目录树与概览、无权访问私有目标成员桌面隔离视图、`390×844` 移动端侧栏目录抽屉），排版清晰、徽章与锁态对齐无重叠裁切；
  - 移动端 `390×844` 实测 `scrollWidth: 390, clientWidth: 390`（`0px` 水平溢出）；
  - 全程 `consoleErrors: []`（**0 条控制台错误或运行异常**）。

---

## 3. 已知边界与后续项

- **真实移动真机触控拖拽**：当前移动端通过目录行菜单「上移 / 下移」完成排序；浏览器原生 HTML5 Drag-and-Drop 在 iOS Safari / Android Chrome 真机触控下的长按拖拽交互尚未接入 Pointer Events 触控手势与真机实测。
- **知识库跨库快捷方式自定义排序**：当前快捷方式按父目录内 `sort_key, id` 顺序渲染在子节点之后，尚未支持将快捷方式与普通页面混排拖拽。
