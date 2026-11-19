# 独立问卷产品（Questionnaire / Survey）验证报告（2026-11-19）

## 一、交付范围（P1 Slice 3）

本轮完成独立 **问卷产品（`kind="survey"`）** 全栈闭环，补齐原差距清单中最后一项 `已缺` 的 P1 能力：

1. **数据库迁移与存储层（PostgreSQL / Memory 对等）**：
   - [0073_surveys.sql](server/internal/migrate/sql/0073_surveys.sql)：扩展 `nodes_kind_check` 允许 `kind='survey'`，新增 `surveys` 表（含 `status IN ('draft','published','closed')`、唯一 `public_token`、`allow_anonymous`、`max_responses`、`questions JSONB` 与递增 `revision` 乐观锁）及 `survey_responses` 表。
   - [server/internal/store/surveys.go](server/internal/store/surveys.go)、[drive-folder.go](server/internal/store/drive-folder.go)、[wiki.go](server/internal/store/wiki.go)、[memory.go](server/internal/store/memory.go)：实现 `SurveyStore`（`GetSurvey`、`GetSurveyByToken`、`SaveSurvey`、`SetSurveyStatus`、`SubmitSurveyResponse`、`ListSurveyResponses`），并将 `survey` 接入云盘与知识库节点创建流程。

2. **REST API、服务端跳题校验与统计聚合**：
   - [server/internal/api/surveys.go](server/internal/api/surveys.go)、[api.go](server/internal/api/api.go)、[drive.go](server/internal/api/drive.go)：
     - 认证端：`GET /api/surveys/{id}`、`PUT /api/surveys/{id}`、`POST /api/surveys/{id}/status`、`GET /api/surveys/{id}/stats`（服务端按题型汇总单选/多选占比、评分均值与分布、矩阵行×列频次、排序平均排名、签名/文本样本）。
     - 公开填写端：`GET /api/public/surveys/{token}` 与 `POST /api/public/surveys/{token}/submit`（支持匿名填写开关、停止收集返回 `410 Gone`、达回收上限返回 `409 Conflict`，并在服务端执行跳题逻辑 `evaluateVisibleSurveyQuestions`，确保被跳过的必填题不会误拦提交）。
   - [server/internal/api/surveys_test.go](server/internal/api/surveys_test.go)：覆盖云盘创建 `survey` 节点、7 类题型与跳题逻辑、发布/关闭生命周期、匿名提交、回收上限 `409` 与统计聚合。

3. **前端问卷工作台、公开填写页与全站入口**：
   - [apps/web/src/pages/survey/survey-page.tsx](apps/web/src/pages/survey/survey-page.tsx)（`#/survey/{id}`）：三标签设计（**编辑问卷** / **发布与回收** / **结果统计**），支持 **单选 / 多选 / 简答 / 评分 / 矩阵量表 / 排序 / 电子签名** 7 种题型、**跳题逻辑配置器**（支持跳转至后续任意题或直接结束提交）、公开链接发布与停止收集、可视化柱状分布条/评分均分卡/矩阵汇总表/排序平均排名榜与 **CSV 导出**。
   - [apps/web/src/pages/survey/public-survey-page.tsx](apps/web/src/pages/survey/public-survey-page.tsx)（`#/q/{token}`）& [signature-pad.tsx](apps/web/src/pages/survey/signature-pad.tsx) & [skip-logic.ts](apps/web/src/pages/survey/skip-logic.ts)：独立公开填写页，支持实时跳题隐藏、星级评分、矩阵单选表、排序上下调整、手写画布电子签名及提交确认页。
   - [route.ts](apps/web/src/lib/route.ts)、[App.tsx](apps/web/src/App.tsx)、[sidebar.tsx](apps/web/src/components/sidebar.tsx)、[home.tsx](apps/web/src/pages/home.tsx)、[drive-page.tsx](apps/web/src/pages/drive-page.tsx)、[en.ts](apps/web/src/i18n/en.ts)：全站接入「新建问卷」入口、紫色问卷图标、类型筛选与路由解析。

---

## 二、自动化与端到端验证结果

| 验证项 | 命令 / 路径 | 结果 |
| --- | --- | --- |
| Go 全量测试（含 `TestStandaloneSurveyFullLifecycleSkipLogicAndStats`） | `cd server && go test ./...` | 通过 |
| 全仓库类型检查 | `pnpm typecheck` | 通过（7/7 包） |
| 前端生产构建 | `pnpm --filter @jiange/web build` | 通过 |
| 全仓库前端/SDK 单元测试（含 `survey.test.ts` 与 `i18n.test.ts`） | `pnpm test` | 通过（239 文件，1,321 用例） |
| 真实 Postgres 16 + Go + Vite + Headless Chrome CDP 验证 | `node scripts/verify-survey.mjs` | 通过（0 控制台错误） |

### CDP 截图人工核验（桌面 `1440×900`）
- `output/survey-verify-20261119/01-survey-designer.png`：问卷设计器展示左侧 7 种题型面板与右侧题卡（含单选题跳题规则、5 分制评分、矩阵量表及排序题）。
- `output/survey-verify-20261119/02-survey-public-form.png`：公开填写页动态验证跳题逻辑（选「暂未使用」实时隐藏第 2、3 题，选「每天使用」恢复显示全部 4 题）并完成星级评分与矩阵量表填写。
- `output/survey-verify-20261119/03-survey-stats.png`：结果统计页准确展示 2 份答卷的占比进度条、5 分均分卡、矩阵频次表、排序平均排名榜与「导出 CSV」入口。
