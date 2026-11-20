# P1 Slice 14：公式安全查找替换、结构化表格历史联动与刷新后本地撤销恢复验证报告（2026-11-20）

## 1. 交付范围与架构实现

本次切片补齐飞书云文档对标清单中「查找替换边界」全部三项核心缺口，覆盖 `@jiange/collab` 与 `@jiange/web` 编辑器层：

1. **公式（块级公式与行内公式）与区分大小写安全查找替换**：
   - 扩展 [find-replace.ts](apps/web/src/editor/find-replace.ts)、[table-find.ts](apps/web/src/editor/table-find.ts)、[find-search-scheduler.ts](apps/web/src/editor/find-search-scheduler.ts) 与 [find-replace-safety.ts](apps/web/src/editor/find-replace-safety.ts)：新增 `FindOptions.includeMath`（默认 `false` 保持普通文本替换零误伤既有契约）与 `caseSensitive`（正文、分栏、公式与表格单元格统一生效）。
   - **块级公式（`type === "math"`）**：启用 `includeMath` 后按 LaTeX 源码精准捕获字符 `OpId`，在 `resolveFindMatch` / `replaceMatches` 中逐块校验类型与字符未漂移后原子替换；`MathBlock`（[editor.tsx](apps/web/src/editor/editor.tsx)）高亮命中卡片并展示带 `<mark>` 定位的等宽 LaTeX 源码条。
   - **行内公式（`marks.math`）**：按原子公式边界（含 `mathId`）提取公式源码匹配区间，同一行内公式内多次命中按倒序聚合并一次性原子重写（替换为空时安全删除整段公式，不遗留残缺数学标记），远端并发改写公式时严格判定过期跳过；`makeRuns` 为命中行内公式透传 `<mark data-find-active>` 高亮投影，保持 `data-model-length` 选区映射完整。
   - 升级 [find-replace-panel.tsx](apps/web/src/editor/find-replace-panel.tsx) 与 [doc-page.tsx](apps/web/src/pages/doc-page.tsx)：新增 `Aa 区分大小写`（`data-find-case-sensitive`）与 `Σ 包含公式`（`data-find-include-math`）快捷开关及动态范围说明。

2. **结构化表格历史纳入安全查找替换**：
   - 重构 [table-structure-history.ts](apps/web/src/editor/table-structure-history.ts) 过渡记录索引为 `transitionId(marker, block)`，在 `afterEditStep` 与 `step` 中按 `block` 统一重基 `table:`、`table-width:`、`find-batch:` 与 `atomic-find:` 全部关联过渡记录。
   - 修复 [find-batch.ts](apps/web/src/editor/find-batch.ts) 中 `FindBatchHistory.finishTableChange` 对早于批量替换的表格结构操作（先插入/删除行再全部替换、随后逆序撤销再重做）的反向别名捕获与重基能力，与 `AtomicFindHistory` 保持一致。
   - 在 [editor.tsx](apps/web/src/editor/editor.tsx) 全链路打通单格替换（`tableFindActionRef`）、跨正文/公式/表格全部替换（`findBatchActionRef` / `findBatchHistoryActionRef`）、含标题原子替换（`startAtomicFind` / `startAtomicFindStep` / `reconcileAlignment`）与表格结构变更（`tableStructureHistoryActionRef` 及全部 5 处结构记录点）的双向历史捕获、冲突门禁与自动重基，消除「先增删行列/合并再替换 → 连续撤销/重做」时的误报冲突。

3. **刷新后本地撤销 / 重做历史安全恢复**：
   - 在 [undo.ts](packages/collab/src/undo.ts) 为 `UndoManager` 新增严格 Schema 校验的 `exportState` / `importState`（按 CRDT `OpId` 与原地更新的 `remap` 链序列化/反序列化，跨刷新与远端并发编辑共存，异常或篡改载荷拒绝写入且不破坏当前栈）。
   - 为 [table-cell-history.ts](apps/web/src/editor/table-cell-history.ts)、[table-structure-history.ts](apps/web/src/editor/table-structure-history.ts) 与 [find-batch.ts](apps/web/src/editor/find-batch.ts) 补充版本守卫状态的 `exportState` / `importState`（反序列化后自动推进序列号避免新键冲突）。
   - 新增 [undo-persistence.ts](apps/web/src/editor/undo-persistence.ts) 并在 [editor.tsx](apps/web/src/editor/editor.tsx) 接入按标签页隔离的 `sessionStorage` 持久化（键名 `jiange:undo-history:v1:{userId}:{docId}`，防抖保存 + `pagehide`/`beforeunload` 同步刷盘，容量上限 512 KiB，自动降档裁剪，同步追齐且 `userId`/`docId`/`epoch` 精确匹配时自动恢复，过滤任何无承载器的孤儿 marker；文档开启防复制 `onCopyBlock` 或只读时严格禁止落盘并立即清除历史记录）。

---

## 2. 自动化测试与构建验证

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| Workspace 全量类型检查 | `pnpm typecheck` | PASS（7/7 项目 0 错误） |
| 前端生产构建 | `pnpm --filter @jiange/web build` | PASS（4,078 modules，无报错） |
| `@jiange/collab` 单元测试 | `pnpm --filter @jiange/collab test` | PASS（20 文件 / 218 用例，含 `undo.test.ts` 新增持久化与防篡改用例） |
| `@jiange/web` 全量单元测试 | `pnpm test` | PASS（247 文件 / 1,363 用例，含新增 `undo-persistence.test.ts` 7 条核心场景用例） |
| 无头 SDK 打包与 NodeNext 校验 | `pnpm test:sdk:pack` | PASS（5 个无头 SDK + 共享 OOXML 均通过） |
| Go 服务端全量单元测试 | `cd server && go test -count=1 ./...` | PASS（全量包 `ok`） |
| 文件命名规范检查 | `pnpm lint:names` | PASS（kebab-case 检查通过） |

---

## 3. 真实 PostgreSQL 16 + 编译 Go 二进制 + Vite + Headless Chrome CDP 端到端核验

执行脚本：`scripts/verify-find-replace-undo.mjs`（PostgreSQL 16 Docker 容器 + 编译后的 `/tmp/jiange-find-undo-srv` + Vite `127.0.0.1:5174` + Headless Chrome CDP，0 控制台错误）：

1. **公式查找高亮与区分大小写**：
   - 文档内实时包含正文 `alpha` / `Alpha`、行内公式 `$$alpha + 1$$`、块级公式 `$$\frac{alpha}{2} + alpha$$` 与 2×2 表格 `alpha 指标`。
   - 默认查找 `alpha` 命中 **3 处**（跳过公式）；开启 `Aa 区分大小写` 精准降至 **2 处**（排除 `Alpha`）；开启 `Σ 包含公式` 精准升至 **5 处**，跳转至块级公式时渲染卡片琥珀色高亮框与等宽 LaTeX 源码定位条（`[data-math][data-find-active="true"]` + `[data-math-find-source] mark`）。
2. **表格结构编辑 + 跨公式与表格全部替换**：
   - 点击表格 `[data-table-add-row]` 新增第 3 行并输入 `alpha 新行`，命中数实时刷新至 **6 处**；执行 `alpha -> omega` 全部替换后，正文、行内公式 `$omega + 1$`、块级公式 `\frac{omega}{2} + omega` 与 2 个表格单元格同步更新，大写 `Alpha` 保持不变。
3. **硬刷新页面（`Page.reload({ ignoreCache: true })`）后连续 3 步撤销与 3 步重做**：
   - 硬刷新追齐 PostgreSQL 16 后确认 `[data-editor][data-undo-ready="true"]` 自动恢复 `sessionStorage` 撤销栈。
   - 连续 3 次 `Ctrl+Z` 依次无冲突撤销：① 全部替换（正文 + 行内公式 + 块级公式 + 表格单元格全部还原为 `alpha`）；② 新行单元格输入（还原为空）；③ 表格结构新增行（表格行数由 3 行干净还原至 2 行，0 冲突弹窗）。
   - 连续 3 次 `Ctrl+Shift+Z` 依次无冲突重做，恢复 3 行表格、`alpha 新行` 与全量 `omega` 替换结果。
4. **桌面与移动端视觉核验**：
   - 桌面端（`1440×900`）3 张截图与移动端（`390×844`）查找替换浮层截图已逐张人工视觉核验，移动端实测 **`0px` 水平溢出**，全程 **0 条控制台报错/异常**。

---

## 4. 已知边界与后续深化方向

- 跨标题原子条件替换（`atomic-find:`）与分栏归档（`column-archive:`）因其依赖跨请求条件日志收据（`ConditionalJournal`），刷新后仍不自动恢复到内存撤销栈，以防止未验证的跨副本标题提交。
- 正则表达式查找替换与跨标签页共享撤销历史留作后续按需扩展。
