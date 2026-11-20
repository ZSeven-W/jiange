# 双向链接持久化索引、全类型资源引用与多跳关系图谱验证报告（2026-11-20）

## 1. 交付范围（P1 Slice 12）

本轮针对 [feishu-gap-audit-20261118.md](feishu-gap-audit-20261118.md)「云文档编辑器（Docs）」中的 **双向链接完整形态** 核心缺口——按需 200 节点全量扫描、非持久化索引、仅覆盖普通文档与仅支持 1 跳关系图——落地完整前后端与 PostgreSQL 持久层闭环：

1. **数据库迁移与 PG / Memory 对等持久化引用索引**
   - `server/internal/migrate/sql/0079_doc_reference_index.sql`：新增 `doc_reference_index_state`（记录各来源节点精确版本戳 `source_kind` / `source_epoch` / `source_seq` / `source_stamp`）与 `doc_reference_edges`（持久化每条出边 `source_node_id`、`target_node_id`、`target_token`、`target_scheme`、`source_block`、`excerpt`、`relation_kind`），并建立来源、目标节点与分享令牌三组索引。
   - `server/internal/store/reference-index.go`、`reference-index-pg.go`、`memory.go`：实现 PG 与 Memory 完全对等的 `ReferenceIndexStore`（批量版本状态查询 `GetReferenceIndexStates`、单事务原子替换 `ReplaceReferenceEdges`、按节点/活跃分享令牌的索引入出边查询 `ListOutgoingReferenceEdges` / `ListIncomingReferenceEdges` / `ListNodeLinkTokens`、批量 `doc_heads` 与 `sheet_workbooks` 版本查询）。
   - `server/internal/api/document-reference-index.go`、`document-references.go`：
     - 增量刷新：命中精确版本戳（文档 `history_epoch + seq`、多维表格 `btHead`、幻灯片页修订和、电子表格 `workbookRevision`、问卷 `revision`）时 **零 CRDT 重放 / 零正文读取**；仅编辑单个节点时仅增量重建该节点；扫描上限从 200 提升至 2,000（超限仍严格返回 `errReferenceIncomplete` 拒绝静默截断）。
     - 分享令牌边（`#/s/<token>` / `#/p/<token>`）独立存储，关闭或轮换分享链接后即时失效而无需重扫来源文档；受限多维表格（含权限锁定视图）绝不写入共享索引，按调用者当前可见视图实时计算，并在返回前统一执行 `SessionUser` + `GetDoc` + `CopyMinRole` TOCTOU 复验。

2. **全类型资源双向引用覆盖（文档 / 画板 / 电子表格 / 多维表格 / 幻灯片 / 问卷）**
   - 服务端提取器覆盖：云文档正文引用、`embed` 内嵌资源块（`relationKind="embed"`）、文档表格单元格与画板/导图节点文本、多维表格记录与字段描述、幻灯片标题/正文/备注/图形文本、电子表格单元格与问卷描述/题目。
   - `GET /api/docs/{id}/references`、`GET /api/account-document-search`、`GET /api/docs/{id}/paste-target`（新增可选 `?kind=` 类型校验）与 `ResolvePasteShareTarget` 及 `publicSafeLink` 统一扩展至 `doc` / `sheet` / `base` / `slides` / `survey` 五类资源。
   - 前端 `apps/web/src/lib/safe-url.ts`、`editor/document-link-paste.ts`、`editor/editor.tsx`、`pages/doc-page.tsx`：打通 `@` 提及选择器直接引用表格/多维表格/幻灯片/问卷/画板（生成规范 `#/<kind>/<id>` 链接）以及粘贴任意类型资源链接自动解析为标题引用卡片。

3. **多跳关系图谱 API 与全资源交互视图**
   - 新增 `GET /api/docs/{id}/reference-graph?depth=1..3`：基于持久化索引执行 1–3 跳广度优先遍历，**每一跳实时校验 `GetDoc` 权限**，无权访问的中间节点既不返回也不穿透遍历其下游邻居，防止通过私密节点间接泄露远端资源；未加入的分享链接作为只读叶节点展示且不向外展开。
   - `apps/web/src/pages/document-reference-graph-layout.ts`、`document-reference-graph.tsx`：新增径向聚类多跳布局 `layoutMultiHopReferenceGraph` 与边界计算 `multiHopGraphBounds`，提供顶栏 `1 跳 / 2 跳 / 3 跳` 切换、六色资源类型节点图标、反向引用/本文引用/资源内嵌（紫虚线箭头）/多跳关联（灰有向箭头）四类边样式、带描边光晕防遮挡标签、全类型资源搜索切换中心及双击直达打开。
   - `apps/web/src/pages/document-references.tsx` 与 `resource-references-button.tsx`：云文档底部引用栏展示资源类型图标/标签与 `内嵌` 徽标；电子表格、多维表格、幻灯片与问卷页顶栏统一接入「引用」入口与右侧双向链接抽屉及全屏多跳关系图。

---

## 2. 自动化与实库验证结果

### 2.1 后端单元测试与 PostgreSQL 16 `-race` 集成测试
- 全量 Go 单元测试：`cd server && go test -count=1 ./...` —— **17 个测试包全部通过**（含 `TestReferenceIndexAndMultiHopMemory` 验证冷启动建索引、热缓存 **0 次 CRDT 重放**、单文档编辑 **仅 1 次增量重放**、全类型资源入出边与 `embed` 标记、1–3 跳图谱、私密中间节点跨跳阻断、`account-document-search` 与 `paste-target?kind=` 类型校验，以及 `TestDocumentReferencesReportScanLimitInsteadOfPartialResults` 验证 205 篇文档成功且超上限仍 fail-closed）。
- 真实 PostgreSQL 16（`postgres:16-alpine`，独立临时 schema）竞态集成测试：
  - `TestReferenceIndexAndMultiHopPostgres` —— **PASS**（5.64s）。
  - `TestPostgresAccountDocumentSearchAccess` —— **PASS**（8.55s）。
  - `TestDocumentReferencesPostgresAccessAndRevocation` —— **PASS**（4.08s）。
  - `internal/migrate`（含 `0079_doc_reference_index.sql`）—— **PASS**（3.923s）。

### 2.2 前端类型检查、构建、单元测试与 SDK 打包检查
- `pnpm typecheck` —— **PASS**（全工作区 7 个工程零错误）。
- `pnpm --filter @jiange/web build` —— **PASS**（Vite 生产构建 4,076 个模块通过）。
- `pnpm test` —— **PASS**（`@jiange/web` **245 个测试文件 / 1,353 条用例** + 全部无头 SDK 与 `@jiange/doc-sdk` 测试全部通过）。
- `pnpm test:sdk:pack` —— **PASS**（5 个打包无头 SDK 与 `@jiange/ooxml` 通过 Node ESM 与 NodeNext 校验）。
- `pnpm lint:names` —— **PASS**（全部跟踪路径符合 kebab-case 规范）。

### 2.3 真实 PostgreSQL 16 + 编译态 Go 服务 + Vite + Headless Chrome CDP 端到端验证
运行脚本：[scripts/verify-reference-index-graph.mjs](scripts/verify-reference-index-graph.mjs)（真实 `postgres:16-alpine` + 编译态 Go 二进制 + Vite `:5174` + Headless Chrome CDP `:9240`）：

- **真实编辑器跨资源引用与内嵌**：在浏览器编辑器内通过 `@` 提及搭建 `项目总纲 -> 系统架构设计 -> 核心机密网关 -> 下游履约服务` 四跳链路并 `@` 引用 `迭代需求多维表`，同时通过 `/嵌入电子表格` 插入真实 `Q4 预算排期表` 内嵌块；配合幻灯片备注、表格单元格与问卷描述回指 `项目总纲`。
- **云文档底部双向引用与非文档资源抽屉**：`项目总纲` 底部正确呈现 `反向引用 (3)`（幻灯片/表格/问卷）与 `本文引用 (3)`（文档/多维表/表格 `内嵌`）；跳转至 `#/sheet/{id}` 点击顶栏「引用」按钮，右侧抽屉准确呈现 `项目总纲`（`文档` + `内嵌`）。
- **多跳关系图（1–3 跳）与私密中间节点权限隔离**：
  - 所有者在 `项目总纲` 打开关系图：默认 `2 跳` 呈现 1 跳全部 5 类资源及 2 跳 `核心机密网关`；切换至 `3 跳` 后呈现全部 **8 个节点 · 8 条关系**（含 3 跳 `下游履约服务` 及与表格并行的蓝实线+紫虚线双边）。
  - 切换至仅获分享 `项目总纲`、`系统架构设计` 与 `下游履约服务`、无权访问 `核心机密网关` 的访客 `陈访客` 并切换至 `3 跳`：图谱严格仅显示 `项目总纲 -> 系统架构设计`（**2 个节点 · 1 条关系**），`leakedC: false`、`leakedD: false`，确认无权中间节点不会穿透泄露下游已分享文档。
- **视觉截图人工核验（桌面 `1440×900` & 移动端 `390×844`）**：
  - 人工逐张核验 4 张 CDP 截图（文档内嵌与底部双向引用桌面图、3 跳全类型资源关系图桌面图、访客跨跳隔离关系图桌面图、`390×844` 移动端 2 跳关系图），带描边光晕的节点标签与边线分离清晰、无重叠裁切；
  - 移动端 `390×844` 实测 `scrollWidth: 390, clientWidth: 390`（`0px` 水平溢出）；
  - 除访客打开含所有者私有内嵌表格的文档触发的预期 `404` 锁卡响应外，**0 条未预期控制台错误或运行异常**。

---

## 3. 已知边界与后续项

- **历史未标记普通链接**：在 `linkKind` 引入前手工插入且未标明 `linkKind="text"` 的旧 `#/doc/` 链接仍沿用历史兼容策略视为引用，尚未引入存量人工迁移工具。
- **匿名公开页与历史版本引用**：匿名公开分享页（`#/p/{token}` 匿名视图）与已保存历史版本快照暂未展示双向引用列表与关系图。
- **超大规模空间后台预热**：当前采用写入版本戳比对 + 首次读取增量刷新；2,000+ 节点超大空间的后台异步事件驱动预热与分页图谱留作后续运维深化。
