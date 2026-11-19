# 全局搜索持久化索引与多维度高级筛选验证报告（2026-11-19）

## 一、交付范围（P1 Slice 4）

本轮完成全局搜索 **持久化全文索引（`doc_search_index`）**、**跨产品深层内容检索（文档 / 表格 / 多维表格 / 幻灯片 / 问卷）** 与 **服务端多维度高级筛选** 全栈闭环：

1. **数据库迁移与存储层（PostgreSQL / Memory 对等）**：
   - [0074_search_index.sql](server/internal/migrate/sql/0074_search_index.sql)：新增 `doc_search_index` 表（`node_id PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE`、`source_epoch`、`source_seq`、`source_stamp`、`body_text`、`indexed_at` 及更新时间索引），避免重复查询时每次全量重放 CRDT 日志或全量解析多维表格/幻灯片/问卷正文。
   - [server/internal/store/search-index.go](server/internal/store/search-index.go) & [server/internal/store/memory.go](server/internal/store/memory.go)：实现 `SearchIndexStore`（`GetSearchIndex`、`UpsertSearchIndex`）在 PostgreSQL 与 Memory 中的对等持久化与原子 Upsert。

2. **增量刷新检索、深层提取与权限隔离**：
   - [server/internal/api/search-favorites.go](server/internal/api/search-favorites.go) & [server/internal/api/mindmap-search.go](server/internal/api/mindmap-search.go)：
     - **文档（`doc` / `board`）**：以 `(source_epoch, source_seq)` 校验 `doc_search_index` 命中，命中时零 CRDT `OpsAfter` 重放；文档头推进后自动重算并增量刷新索引，保留 `\x1f` 分段边界以防跨块误匹配，排除公式/Mermaid 源码。
     - **多维表格（`base`）**：深入索引数据表名、字段名/说明/选项与记录单元格值；对受锁定视图限制的非管理员用户（`baseRestricted`）绕过共享索引并严格按表级可见行列实时过滤，杜绝越权泄露隐藏记录。
     - **幻灯片（`slides`）**：深入索引页面标题、正文、演讲者备注（`notes`）及画布图形文本（`shapes[].text`）。
     - **问卷（`survey`）**：深入索引问卷说明、题干、题目描述、选项及矩阵量表行列文案。
     - **服务端筛选参数**：`GET /api/search` 新增并校验 `kind`（含 `doc`/`board`/`sheet`/`base`/`slides`/`survey`/`folder`/`file`）、`owner`（`all`/`mine`）、`folderId`（含权限校验与多级嵌套子孙目录匹配）及精确日期范围 `updatedFrom` / `updatedTo`（非法参数返回 `400 Bad Request`），并对每个命中项二次复验 `GetDoc` 授权与最新标题。
   - [server/internal/api/search-index_test.go](server/internal/api/search-index_test.go)：覆盖 `doc_search_index` 缓存命中（零额外 `OpsAfter`）与头推进增量刷新、多维表格/幻灯片/问卷深层检索、锁定视图防越权泄露、多级目录筛选与无权目录隔离、所有者与日期范围筛选及非法参数 `400` 校验。

3. **前端高级搜索面板与全站类型支持**：
   - [apps/web/src/lib/api.ts](apps/web/src/lib/api.ts) & [apps/web/src/lib/search-api.test.ts](apps/web/src/lib/search-api.test.ts)：扩展 `extrasApi.search(q, signal, filters)` 序列化 `kind`、`owner`、`folderId`、`updatedFrom`、`updatedTo`。
   - [apps/web/src/components/global-search.tsx](apps/web/src/components/global-search.tsx)、[global-search.test.ts](apps/web/src/components/global-search.test.ts) & [en.ts](apps/web/src/i18n/en.ts)：高级搜索面板新增「所在目录」多级面包屑下拉（`buildFolderOptions`）、「开始日期 / 结束日期」精确日期选择器、「问卷」类型筛选与紫色图标展示、「重置筛选」入口；支持无关键词时仅凭目录或日期条件直接发起服务端筛选检索。

---

## 二、自动化与端到端验证结果

| 验证项 | 命令 / 路径 | 结果 |
| --- | --- | --- |
| Go 全量测试（含 `TestSearchIndexCachesAndIncrementallyRefreshesDoc`、`TestSearchDeepMultiResourceAndFiltersHTTP`） | `cd server && go test ./...` | 通过 |
| Go 竞态检测（搜索用例）与 Postgres 16 迁移测试 | `cd server && go test -race ./internal/api -run TestSearch` & `JIANGE_TEST_DATABASE_URL=... go test ./internal/migrate` | 通过 |
| 全仓库类型检查 | `pnpm typecheck` | 通过（7/7 包） |
| 前端生产构建 | `pnpm --filter @jiange/web build` | 通过 |
| 全仓库前端/SDK 单元测试（含 `global-search.test.ts`、`search-api.test.ts`、`i18n.test.ts`） | `pnpm test` | 通过（239 文件，1,324 用例） |
| 真实 Postgres 16 + Go + Vite + Headless Chrome CDP 验证 | `node scripts/verify-search-index.mjs` | 通过（0 控制台错误；实库 `doc_search_index` 已落盘多维表格/幻灯片/问卷索引记录） |

### CDP 截图人工核验（桌面 `1440×900` 与模拟手机 `390×844`）
- `output/search-index-verify-20261119/01-search-deep-survey.png`：桌面全局搜索输入问卷单选选项深层文案「极速响应」，立即命中并展示带紫色问卷图标的「客户满意度问卷」。
- `output/search-index-verify-20261119/02-search-folder-date-filter.png`：桌面无关键词下组合筛选「文档类型 = 多维表格」「所在目录 = 研发档案」「开始/结束日期 = 当天」，精准命中嵌套两级目录（`研发档案 / Q4 专项`）下的「供应链台账」并展示「重置筛选」入口。
- `output/search-index-verify-20261119/03-search-mobile.png`：`390×844` 模拟移动端下两列高级筛选网格与结果列表自适应排布，无横向溢出或遮挡。

### 已知边界与后续计划
- 当前索引在检索读取时按版本惰性增量刷新，尚未接入写入侧后台异步预热队列与数据库侧 `pg_trgm`/全文检索下推；精确创建时间范围筛选及二进制附件正文提取留作后续增强。
