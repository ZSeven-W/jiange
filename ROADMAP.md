# Jiange ROADMAP（交接给 AI coding agent）

> 本文是给本地 AI coding agent 的交接说明：读完即可继续开发。完整功能拆解见计划 canvas `e1d25e3a-0026-4d39-b35c-411f9fff716b`（"开源飞书文档 + 多维表格克隆：功能拆解与 MVP 方案"），本文已摘录其中剩余部分。

## 1. 目标与硬约束（Hard constraints）

- 目标：开源、可自部署的 **飞书文档（Docs）+ 多维表格（Bitable）** 克隆。品牌叫 **Jiange**，UI 参考飞书风格（Feishu-inspired），但**不得使用飞书 logo、商标或素材**。
- **只能用基础库**，其余全部自研：
  - 前端：React、Vite、TypeScript、TanStack Query、Tailwind、shadcn/ui（含 Radix、cmdk）。
  - 后端：Go stdlib、`github.com/coder/websocket`、`github.com/jackc/pgx/v5`。
  - **禁止** Yjs / Tiptap / ProseMirror / BlockNote / Slate / Lexical / 任何现成 CRDT 或编辑器框架；也不要引入 ORM、router、S3 SDK、状态管理库。
- 协同模型是自研的（`packages/collab` + `server/collab`）：文本用 Fugue 序列 CRDT，块树和属性用 LWW，marks 用 Peritext 的 expand 规则，由服务器定序（seq）。**TS 和 Go 两份实现必须对同一组 vectors 输出一致**。
- **先设计，后实现（Design first）**：新 UI 先在 OpenPencil 里设计（`design/screens.js` → `design/build.py` 生成 `design/jiange.op` 和 `design/previews/*.png`），再写代码。OpenPencil 跑不起来就如实报告，**不得伪造设计稿**。
- Git：正常 commit 后 push 到 `main`，**禁止 force-push**。CI 见第 7 节。

## 2. 仓库结构（Repo map）

```
apps/web/                 React 前端（Vite）
  src/editor/             自研块编辑器：Editor.tsx（contenteditable + beforeinput 拦截、IME）、model.ts（split/join/paste/marks）、
                          dom.ts（DOM↔model 选区映射，按 code point）、pinyin.ts（斜杠菜单拼音匹配）、SlashMenu、FormatToolbar
  src/pages/              DocPage、BasePage（多维表格表格视图）、Trash、JoinLink（#/s/:token）、Home、Login、Playground
  src/components/         Sidebar（文档树 + 与我共享）、ShareDialog、CollabText（标题）、ui/（shadcn 风格组件）
  src/lib/                api.ts（REST 客户端）、useSyncDoc.ts（同步 + localStorage 离线队列）、route.ts（hash 路由）、presence.ts
packages/collab/          TS 协同内核：doc.ts（Fugue/LWW/marks，END_ANCHOR）、tx.ts（事务 + UndoItem）、undo.ts（只撤销本地操作）、
                          sync.ts（SyncClient：restore/pendingOps）、codec、scenarios.ts（生成 vectors）
server/
  cmd/jiange/             入口（迁移、HTTP、sync hub、S3）
  collab/                 Go 协同内核（与 TS 对齐）
  internal/api/           REST：auth、docs、trash/move、share（角色/链接/附件）、base（多维表格）
  internal/store/         Store 接口 + Memory（测试用）+ Postgres 两套实现（每个新方法两边都要写）
  internal/migrate/sql/   0001..0005 迁移（0004 分享/附件，0005 base_fields/base_records）
  internal/syncsrv/       WebSocket 同步服务（hello/ops/ack/awareness，viewer 只读）
  internal/blob/          附件存储：Memory + S3（自写 SigV4，对接 MinIO）
spec/PROTOCOL.md, spec/vectors/   同步协议说明 + TS/Go 一致性测试向量
design/                   OpenPencil 设计源码与预览图
ci/github-actions-ci.yml  CI 配置（待移到 .github/workflows，见第 7 节）
docker-compose.yml        Postgres 16 + MinIO
```

## 3. 运行与测试（Run & test）

```bash
pnpm install
docker compose up -d                       # Postgres :5432（jiange/jiange），MinIO :9000/:9001（jiange/jiange-dev-secret）
cd server && DATABASE_URL=postgres://jiange:jiange@localhost:5432/jiange?sslmode=disable \
  JIANGE_S3_ENDPOINT=http://localhost:9000 JIANGE_S3_ACCESS_KEY=jiange JIANGE_S3_SECRET_KEY=jiange-dev-secret \
  go run ./cmd/jiange                      # :8080，启动时自动执行迁移、自动创建 bucket
pnpm --filter web dev                      # :5173，/api 代理到 :8080
```

环境变量（Env vars）：`JIANGE_ADDR`（默认 `:8080`）、`DATABASE_URL`、`JIANGE_SESSION_TTL`（默认 `720h`）、`JIANGE_SECURE_COOKIES`、`JIANGE_ALLOWED_ORIGINS`（默认 `localhost:5173,127.0.0.1:5173`）、`JIANGE_S3_ENDPOINT` / `_ACCESS_KEY` / `_SECRET_KEY` / `_BUCKET`（默认 `jiange`；不配 endpoint 时附件功能关闭）。

测试：
- `pnpm -r test`：collab 102 个测试 + web 12 个测试；`pnpm -r typecheck`；`pnpm --filter web build`。
- `cd server && go vet ./... && go test -p 1 ./...`：Postgres 集成测试**只在**设置 `JIANGE_TEST_DATABASE_URL` 时运行（指向一个可丢弃的库，测试会 `DROP SCHEMA public`）。必须加 `-p 1`，因为多个包共用这个库。
- 改动协同语义后要跑 `pnpm gen:vectors` 重新生成 `spec/vectors`，并让 Go 测试通过。

## 4. 阶段状态（Phase status）

| 阶段 | 内容 | 状态 / commit |
|---|---|---|
| P0 | 脚手架、auth、session、workspace、登录页 | ✅ |
| P1 | 协同内核（Fugue/LWW/marks）、TS/Go vectors 一致 | ✅ |
| P2 | 同步服务（WebSocket、seq、ack、快照、awareness）、文档页 | ✅ `2d019b5` |
| P3 | 自研块编辑器、Peritext expand、Tx/Undo、嵌套树、离线队列 | ✅ `955cfdd`, `79eb4db` |
| P4 | 回收站/移动、三级角色（view/edit/manage，可继承）、链接分享、@文档、附件（MinIO） | ✅ `9e45245`, `aaa492b` |
| P5.1 | 多维表格数据模型 + REST（text/number/select/checkbox/date，单元格校验） | ✅ `1dbb89d` |
| P5.2 | 表格视图（行内编辑、加行/加字段），侧栏新建多维表格 | ✅ `292c775` |
| P5.3 | 客户端排序（空值置底）+ 关键字筛选 | ✅ `45cdeb8` |

截图在 `/workspace/shots/p3-*.png`、`p4-*.png`、`p5-*.png`（box 本地，不在仓库里）；设计预览在 `design/previews/`。

## 5. 剩余工作清单（每项附验收标准 Acceptance criteria）

### P5 多维表格 MVP（剩余部分）
- [ ] **P5.4 字段与表头编辑**：表头菜单支持重命名、改类型（带值转换或清空提示）、删除、拖拽排序（改 position）、列宽调整；多维表格可重命名。
  - 验收：所有操作 F5 刷新后仍在；字段类型改错时 API 返回 400；有 Go API 测试。
- [ ] **P5.5 单元格选区与键盘操作**：方向键、Tab、Enter 在单元格间移动；Enter/直接输入开始编辑；Esc 取消；Delete 清空；多单元格复制粘贴（TSV，可与 Excel 互通）。
  - 验收：只用键盘就能完成 10 行录入；有 vitest 覆盖粘贴解析。
- [ ] **P5.6 实时协同（行级 LWW）**：在现有 sync hub 上开 base 房间，或另设 `bt_ops` 表；每个单元格是 LWW 寄存器（服务器 seq 定序），字段增删也要广播。
  - 验收：两个浏览器同时编辑，1 秒内收敛；同一单元格并发写入时，两端结果一致（后写者胜）；断线重连后补发；有 Go 测试 + TS 测试。
- [ ] **更多字段类型**：多选、人员（workspace 成员）、附件（复用 `/api/docs/{id}/files` 的同一套 blob 存储）、创建人、创建时间、修改时间。做一个字段类型注册表（Field type registry），统一负责校验、编码、渲染、编辑器和排序比较。
  - 验收：每种类型都有服务端校验测试和前端渲染。
- [ ] **视图持久化（Views）**：新建 `bt_views(id, base_id, type, config jsonb, pos)`；把筛选（多条件，且/或）、排序（多级）、分组、隐藏字段存进 config；服务端把 config 编译成 SQL（jsonb 表达式）；临时改动只存本地，点“保存”才写回。
  - 验收：1 万行数据筛选+排序在 200ms 内完成（服务端）；有编译器单测，并防 SQL 注入。
- [ ] **虚拟滚动表格**：行列双向虚拟化，首列冻结。
  - 验收：1 万行 × 30 列滚动不卡顿，DOM 节点数不超过 2000。
- [ ] **看板视图（Kanban）**：按单选字段分列，拖拽卡片即改值，列内拖拽改 position。
  - 验收：拖拽后另一端实时看到变化；空值归入“未分组”列。
- [ ] 多维表格的分享、权限、回收站：复用 nodes 上的角色（已通过 `kind='base'` 支持），回收站里要标出 base 类型。

### P6 版本、导入导出、发布
- [ ] **历史版本**：手动和自动（按间隔）把快照标记为 `is_version`；侧栏列出版本；可预览只读内容；“还原”= 由当前状态生成逆向操作并作为新操作提交（不改写历史）。
  - 验收：还原后其他在线用户实时看到变化；撤销栈不受影响；有 TS/Go 测试。
- [ ] **Markdown 导入/导出**：覆盖标题、列表（含缩进）、待办、引用、代码块、分割线、粗体/斜体/删除线/行内代码/链接、图片和附件链接。
  - 验收：round-trip（md → doc → md）对一组样例文件幂等；有 vitest。
- [ ] **CSV 导入/导出（多维表格）**：可自动推断字段类型，也可手动指定。
  - 验收：1 万行 CSV 导入在 5s 内完成，失败的行有报告。
- [ ] **性能与兼容**：长文档（5 万字）输入延迟 < 16ms；Safari/Firefox 下 IME 正常；快照压缩（compaction）。
- [ ] **发布 v0.1**：Dockerfile（单个二进制，用 embed 打包前端）、docker-compose 一键部署、文档站（docs/）、CHANGELOG、LICENSE 检查。
  - 验收：在干净机器上 `docker compose up` 后能注册、编辑、分享、上传附件。

### 文档 v2（来自计划）
- [ ] 评论与通知：划词评论锚定到字符 ID（anchor），能 @人、resolve，有通知中心（`comments` / `notifications` 表）。
- [ ] 高级块：高亮块（callout）、公式（KaTeX 不算基础库 → 需要自研或先跳过）、网页卡片、视频、分栏、表格块。
- [ ] 嵌入：`bitable_view` 块只存 `{ baseId, viewId, height }`，渲染时挂载同一个表格组件，权限单独校验。
- [ ] 模板（复制快照）、细粒度分享开关（禁止复制/下载、链接密码、匿名访问）。
- [ ] AI 写作（作为一个协作者流式产生操作），后做。

### 多维表格 v2（来自计划）
- [ ] 日历视图、画册视图（附件封面）、表单视图（公开链接 → 新增一行）。
- [ ] 公式引擎：自研 parser + evaluator，Go 和 TS 共用同一份语法，先做约 30 个函数；用依赖图（dependency graph）做增量重算。
- [ ] 关联 / 查找引用（`bt_links`，单向和双向）。
- [ ] 行级、列级权限（在查询时注入谓词）。

## 6. 已知问题与技术债（Known gaps / tech debt）

- 列表用 `indent` 属性表示层级，不是真正的嵌套块树；粘贴 HTML 时只保留纯文本。
- 面包屑不显示祖先目录；共享文档的面包屑显示的是当前用户自己的 workspace 名。
- 链接分享要求登录（不支持匿名访问）；没有链接密码。
- 多维表格没有实时同步（每次修改后重新拉取）；排序和筛选只在客户端做；单元格选区和复制粘贴都还没有。
- 斜杠菜单的“图片/附件”在 headless 测试里拿不到 filechooser 事件（测试改用 `setInputFiles('[data-file-input]')`）。
- web 没有 prettier 配置：如果要格式化，只格式化你改过的文件，用 `--print-width 200`，别整仓重排。
- Memory 和 Postgres 两套 store 需要手动保持一致：每加一个接口方法，就要两边实现、两边测试。

## 7. 约定（Conventions）

- **每个改动都必须有测试**：Go（api 用 Memory store 的 httptest，store 有 Postgres 集成测试）+ TS（vitest）。协同语义的改动必须更新 `scenarios.ts`、重新生成 vectors，并保证 **TS 和 Go 对 vectors 的结果一致**。
- 提交前必须全部通过：`go vet`、`go test -p 1 ./...`、`pnpm -r test`、`pnpm -r typecheck`、`pnpm --filter web build`。
- Commit 风格：`P5.4: <简述>` / `fix: ...` / `docs: ...`，按小切片、能独立提交的粒度。每个切片做完就 push。
- UI 文案用中文；颜色等 token 见 `design/tokens` 和 `index.css`（主色 `#3370FF`）。
- 安全：写操作接口只接受 `application/json`（CSRF）；上传接口必须带 `X-Jiange-Upload: 1` 头；权限统一走 `need(w, r, role)`。
- **CI**：`ci/github-actions-ci.yml` 需要移到 `.github/workflows/ci.yml` 才会生效。之前的 token 没有 `workflow` scope，所以一直没移。用有权限的 token 移过去即可（`git mv ci/github-actions-ci.yml .github/workflows/ci.yml`）。
