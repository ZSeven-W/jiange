# 电子表格嵌入式图表与数据透视表深化验证报告（2026-11-20）

## 1. 目标与范围（P1 深化 Slice 17）

针对 [feishu-gap-audit-20261118.md](feishu-gap-audit-20261118.md)「独立普通电子表格（Sheet）→ 高级表格分析与 `.xlsx` 样式保真」中的既有深化项，本轮完整落地**工作表嵌入式图表（Embedded Charts）**与**数据透视表（Pivot Tables）**前后端与 PostgreSQL 持久化闭环：

1. **后端持久化、行列重映射与副本重绑（PostgreSQL 16 + Memory 对等）**
   - 新增 SQL 迁移 `server/internal/migrate/sql/0082_sheet_charts_and_pivots.sql`，为 `sheet_worksheets` 新增 `charts jsonb NOT NULL DEFAULT '[]'::jsonb` 与 `pivot_tables jsonb NOT NULL DEFAULT '[]'::jsonb`。
   - 新增 `server/internal/store/sheets-analytics.go`：
     - 定义 `SheetChart`（`column | bar | line | area | pie`、源矩形 `top/left/bottom/right`、`headerRow`、画布浮动坐标与尺寸 `x/y/width/height`、`showLegend`、`showValues`）与 `SheetPivotTable`（可选跨表 `sourceSheetId`、源矩形、`rowFields` 1..3、`colField` 可选、`values` 1..6 支持 `sum | count | avg | min | max`、`showRowTotals`、`showColTotals`、`sortBy`）。
     - 严格服务端规范化校验（`validateAndNormalizeSheetCharts`、`validateAndNormalizeSheetPivotTables`），自动校验数量上限、坐标/尺寸安全边界、字段越界与行/列维度冲突。
     - 接入 `MutateSheetAxis`（插入/删除行与列）：自动平移与伸缩图表及透视表源区域；在源区域内部增删列时同步重映射透视表 `rowFields`、`colField` 与 `values[].col` 相对列偏移，删除全部源行/列或关键维度时安全裁剪。
     - 接入 `CopySheetWorkbook`：完整克隆图表与透视表配置，并将跨工作表透视表的 `sourceSheetId` 自动重映射到副本对应的新工作表 ID（PostgreSQL 与 Memory 双实现一致）。
     - 复用 `PATCH /api/sheets/{id}/worksheets/{wid}` 与 WebSocket `Hub.Notify`，图表/透视表变更即时广播给其他协作者。

2. **前端纯分析引擎与单元测试（`sheet-analytics.ts` / `sheet-analytics.test.ts`）**
   - `extractChartDataset`：直接读取公式求值引擎 `EvaluatedSheetMap`，智能识别多列源区域中的文本分类列并合并为复合 X 轴标签（如 `部门` + `季度` → `市场部·Q1`），跳过纯文本列避免生成零值误导系列，仅将含数值列提取为图表系列；单元格或公式更新时实时联动刷新。
   - `detectDataTableRange` / `detectFirstNumericColOffset`：从当前聚焦单元格自动探测连续数据表区域，并自动推荐首个数值列作为数据透视表默认聚合字段。
   - `computePivotTable`：支持 1–3 列行维度、可选列交叉维度（Cross-tab）、1–6 个多指标聚合（求和/计数/均值/最小/最大）、按行标签或数值升降序排序、行总计与列总计，全程直接计算公式结果列。
   - `pivotResultToCellMatrix`：将透视计算结果转换为带表头背景 `#eef3ff`、细边框、数字右对齐与加粗总计行 `#f5f6f7` 的二维单元格写入矩阵。

3. **浮动 SVG 嵌入式图表与透视表交互闭环**
   - `apps/web/src/pages/sheet/sheet-chart-overlay.tsx`：在工作表网格层之上渲染 5 类浮动 SVG 图表（柱状图、条形图、折线图、面积图、环形饼图），支持悬浮提示、图例、可选数值标注、拖拽标题栏移动位置（`data-sheet-chart-drag`）、拖拽右下角缩放尺寸（`data-sheet-chart-resize`）、快捷编辑与删除；移动/缩放采用同步事件绑定与卸载清理，落盘到 PostgreSQL。
   - `apps/web/src/pages/sheet/sheet-analytics-panels.tsx`、`sheet-panels.tsx`、`sheet-toolbar.tsx`、`sheet-page.tsx`：
     - 工具栏新增「图表」与「透视表」入口，右侧抽屉扩展至 6 模式切换（图表 / 透视 / 验证 / 条件 / 保护 / 评论），透视模式下桌面端自适应加宽至 `400px` 展示实时交叉透视预览表。
     - 支持「保存透视配置」（持久化到工作表并支持点击回填编辑）与「生成到新工作表」（一键创建去重命名的独立工作表、按需扩容行列、批量写入带样式透视结果，并根据表头/单元格字符宽度自动调用 `resize_col` 适配列宽防止表头截断）。
   - `apps/web/src/i18n/en.ts` 补齐全部 56 条新增中英文词条并通过 i18n 完整性单测。

---

## 2. 自动化测试与构建验证

| 检查项 | 命令 | 结果 |
| --- | --- | --- |
| Go 全量单测（含新增 `TestMemorySheetChartsAndPivots`） | `cd server && go test -count=1 ./...` | **PASS**（全部 Go 包通过） |
| PostgreSQL 16 迁移链验证（含 `0082_sheet_charts_and_pivots.sql`） | `JIANGE_TEST_DATABASE_URL=... go test -p 1 -count=1 ./internal/migrate` | **PASS**（`5.509s`） |
| PostgreSQL 16 电子表格 Store 集成测试（图表/透视/行列偏移/副本跨表重映射 + 并发合并 + 基础 Store） | `JIANGE_TEST_DATABASE_URL=... go test -v -count=1 -run 'TestPostgresSheet' ./internal/store` | **PASS**（`TestPostgresSheetChartsAndPivots`、`TestPostgresSheetConcurrentMerge`、`TestPostgresSheetStore` 全部通过） |
| 全仓 TypeScript 类型检查 | `pnpm typecheck` | **PASS**（7 个 workspace 项目全部通过） |
| Web 生产构建 | `pnpm --filter @jiange/web build` | **PASS** |
| 前端单元测试（含 `sheet-analytics.test.ts` 与 `i18n.test.ts`） | `pnpm test` | **PASS**（250 个测试文件，1373 条用例全部通过） |
| Headless SDK 打包校验 | `pnpm test:sdk:pack` | **PASS** |
| 文件命名规范校验 | `pnpm lint:names` | **PASS**（0 违规） |

---

## 3. 真实 PostgreSQL 16 + 编译后 Go 服务 + Headless Chrome 端到端验证

运行 `scripts/verify-sheet-charts-pivots.mjs`（PostgreSQL 16 临时容器 `jiange-pg-slice17` + 编译后 Go 服务 `127.0.0.1:8080` + Vite `127.0.0.1:5174` + Headless Chrome CDP `127.0.0.1:9227`），实测全链路闭环：

1. **公式表建模与嵌入式图表创建**：在 `Sheet1` 写入 7 行 × 5 列销售明细表（`部门 / 季度 / 销售额 / 成本 / 利润`，其中 `利润 = C{n}-D{n}`），在右侧「图表」面板插入柱状图 `部门季度业绩对比 (A1:E7)`，验证仅提取 3 个数值系列（`销售额 / 成本 / 利润`，共 18 根 SVG 柱体），`部门` 与 `季度` 自动组合为 `市场部·Q1` 等 X 轴分类标签。
2. **图表拖拽移动与公式实时联动**：通过真实指针拖拽将柱状图移动至 `x=570, y=40`；再插入环形饼图 `销售额分布占比 (A1:C7)`（验证渲染 6 片 SVG 扇区与中心 `总计 1.0k`）；随后将单元格 `C5` 由 `260` 编辑为 `300`，公式格 `E5` 即刻更新为 `160` 且柱状图同步重绘包含 `160`。
3. **跨维度实时数据透视与物化工作表**：切换至「透视表」面板，配置行维度=`部门`、列交叉维度=`季度`、聚合值=`利润 (求和)`，实时预览准确输出 `研发部 (90 / 160 / 250)`、`市场部 (50 / 85 / 135)`、`交付部 (35 / 60 / 95)` 及 `总计 (175 / 305 / 480)`；点击「保存透视配置」并点击「生成到新工作表」，自动创建并跳转至 `透视-各部门季度利润透视`，表头与总计行样式及自动列宽完整呈现无截断。
4. **整页刷新 PostgreSQL 持久化验证**：执行 `Page.reload` 后，确认新生成的透视工作表、两张嵌入式图表（含柱状图拖拽后 `left=570` 坐标与饼图配置）以及已保存的透视表配置全部完整还原。
5. **桌面（`1440×900`）与移动端（`390×844`）视觉与零错误验证**：人工检查全部 5 张截图（柱状图+饼图桌面视图、透视抽屉桌面视图、物化透视工作表桌面视图、移动端透视抽屉与移动端表格图表视图），确认布局整洁、无重叠截断、桌面与移动端横向溢出均为 `0px`、`consoleErrors = 0`、`pageErrors = 0`。

---

## 4. 遗留边界与后续演进方向

- `.xlsx` 导入导出目前保持现有多工作表/公式/基础样式/合并/冻结链路，嵌入式图表/透视表的原生 OOXML `xl/charts`、`xl/pivotTables` 双向编解码以及复杂边框/渐变/条件格式规则导出留作后续按需扩展。
- 透视表当前支持单步物化为静态带样式工作表并保存动态配置供随时重算；工作表内动态刷新锚定透视区与切片器控件留作后续体验深化。
