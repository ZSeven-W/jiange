# 文档表格标题行吸顶验证（2026-11-16）

[飞书文档表格说明](https://www.feishu.cn/hc/zh-CN/articles/639833584167-%E5%9C%A8%E6%96%87%E6%A1%A3%E4%B8%AD%E6%8F%92%E5%85%A5%E8%A1%A8%E6%A0%BC)说明标题行在滚动文档时吸顶。Jiange 现有标题行开启时会贴住当前文档滚动视口，随表格末尾离开；关闭标题行时不吸顶。表格横向滚动时标题与正文列保持对齐。吸顶使用原有标题行，因此编辑器内可直接继续编辑表头；跨行合并的标题单元格在吸顶时裁剪到标题行高度，避免覆盖后续行。

在隔离 PostgreSQL、真实 Go 服务、合成账号和 Chrome 中验证了 25 行、12 列表格：吸顶位置、表头编辑、另一页面的表头修改同步、横向滚动、表格结束后退出、关闭标题行、跨行合并单元格不会遮挡下一行、匿名公开页和演示页。还检查了打印媒体样式及 `beforeprint`/`afterprint` 状态恢复；没有操作真实打印机。390×844 截图与触摸事件为浏览器模拟，不代表实体手机已验证。

- [桌面吸顶](jiange-document-table-sticky-desktop-20261116.png)
- [横向滚动](jiange-document-table-sticky-horizontal-20261116.png)
- [模拟移动端](jiange-document-table-sticky-mobile-20261116.png)
- [匿名公开页](jiange-document-table-sticky-public-20261116.png)
- [演示模式](jiange-document-table-sticky-presentation-20261116.png)

复现：在隔离环境启动应用及专用 Chrome 调试端口，设置 `JIANGE_TABLE_TEST_URL`、`JIANGE_TABLE_CDP_URL` 后运行 `node scripts/verify-document-table-sticky.mjs`。脚本会创建合成账号、文档和匿名链接；`JIANGE_TABLE_SCREENSHOT_DIR` 可指定截图目录。

本次依据官方功能描述实现，未逐像素比对登录后的飞书；Safari、Firefox、实体手机及虚拟键盘仍需核验。表格单元格富内容、格式与完整协同模型仍未完成。
