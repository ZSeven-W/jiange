# Changelog

## 0.2.0

完整飞书协作套件能力、AI 原生工作区、政企安全合规与 13 包零依赖 SDK 体系落地。

### 云文档与知识库
- 原生 CRDT 媒体与交互块：`audio` / `video` / `poll` 实时投票 / `countdown` 倒计时 / `tabs` 标签页，支持公开只读态安全投影
- **行内修订模式（Track Changes）**：锚定块下方红删绿增 diff 对比与一键接受/拒绝
- 跟随阅读模式（Follow Mode）、文档底部表情回应云端持久化、Markdown 含图导入与 DOCX 双向导入导出
- 独立知识库空间、跨空间移动（个人 / 共享 / 跨工作空间）与全格式在线预览（PDF、音视频、代码/Markdown/CSV、`.docx` / `.xlsx` / `.pptx`，登录态与公开只读态均支持）

### 电子表格
- WebGPU/WebGL2 百万行虚拟网格与 **148 个内置公式函数**（新增 `LET` / `LAMBDA` / `ARRAYFORMULA` / `QUERY` / `REGEXMATCH` / `REGEXREPLACE` / `REGEXEXTRACT` / `IMAGE`）
- 行内 SVG 迷你图（`line` / `bar` / `winloss`）、行列折叠分组、单元格图片、浮动图表、数据透视表
- 云端命名区域、工作簿版本历史、单元格变更历史、打印与 PDF 导出、XLSX/CSV 双向与表格 AI 公式助手

### 多维表格
- 扩展至 **23 种字段类型**（新增 `currency` / `progress` / `autonumber` / `button` / `location`）与 **7 种视图**（新增层级树视图 `hierarchy`）
- 最多 3 级嵌套分组、甘特图依赖连线、条件分支公开表单、云端列宽与汇总统计、多步自动化工作流
- 多角色细粒度行/列 RBAC、XLSX/CSV 导入导出与 AI 按列批量填充

### 幻灯片与画板/脑图
- 幻灯片母版与品牌套件（Master Brand Kit）、`video`/`audio` 媒体形状、图片裁剪、交互式表格/图表、元素逐项动画、批注评论与版本历史
- 演讲者激光笔/画笔批注与基于 WebSocket 的观众实时跟随放映
- 画板头脑风暴便签、荧光笔、圆点投票、小地图、倒计时与分组框架；脑图外框、概要、徽章与大纲双向同步

### 政企安全、开放生态与深度离线
- OIDC / OAuth2 单点登录（SSO）、TOTP MFA 二步验证与恢复码、全套件防泄密水印、公开分享密码
- 企业安全审计日志与 CSV 导出、**企业 DLP 敏感词/正则防泄漏拦截与数据保留策略**
- **PAT 个人访问令牌**、空间事件 HMAC-SHA256 Webhook、外部通知渠道（SMTP 邮件 / 飞书 / 钉钉 / 企业微信 / Slack 机器人）
- **SCIM 2.0 身份供应接口（`/scim/v2/*`）**与 **OpenAPI 3.1 开放接口规范（`/api/openapi.json`）**及组织架构开发者调试台
- 多工作空间新建与侧栏切换、全空间 AI 知识库 RAG 问答（带权限隔离与原文引用）、移动端响应式与 **PWA + IndexedDB 深度离线缓存与队列重放**

### SDK 与 CLI
- 13 个零第三方依赖 TypeScript Headless & WebGPU/WebGL2 UI SDK 包（`0.2.0`）、零依赖 Go 1.23 后端 SDK + PostgreSQL 适配器、单静态二进制 Go CLI & MCP Server

---

## 0.1.0

首个可用版本：自研 CRDT 块编辑器、基础多维表格（6 视图 / 18 字段）、全文搜索、通知中心、中英国际化与 Docker 自部署。
