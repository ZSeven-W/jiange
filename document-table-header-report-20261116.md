# 文档表格标题列验证（2026-11-16）

依据[飞书文档表格说明](https://www.feishu.cn/hc/zh-CN/articles/639833584167-%E5%9C%A8%E6%96%87%E6%A1%A3%E4%B8%AD%E6%8F%92%E5%85%A5%E8%A1%A8%E6%A0%BC)，标题行和标题列可分别设置。Jiange 本次增加标题列开关，可在表格工具栏或左上角块菜单操作；标题行与标题列可单独或同时开启。标题列样式在编辑、只读/匿名分享和演示视图使用同一文档属性；旧文档默认不启用标题列，原有标题行默认值保持不变。

标题行和列的切换纳入现有表格结构撤销历史：同一页面连续切换可依次撤销和重做；已接收的协作者表格变更会保守地阻止旧撤销。旧格式表格首次切换标题时会先迁移到现有的单元格属性模型；撤销标题不会撤销这次内部迁移，以免隐藏离线协作者对这些单元格的后到编辑。该撤销目前不是服务端条件提交，在途的并发普通写入仍可能竞争；历史仅保留当前会话，旧客户端不显示新标题列样式。Word 和 Markdown 导出会提示表格设置可能丢失。

在隔离 PostgreSQL、合成账号和 Chrome 下验证了真实鼠标切换、双页面同步、连续撤销/重做、另一页面先修改后拒绝旧撤销、刷新保存、块菜单开关，以及匿名分享和演示页面的标题行列呈现。320×720 是浏览器模拟移动视口；测试检查了工具栏没有裁切，并非实体手机操作。

- [桌面编辑](jiange-document-table-header-desktop-20261116.png) / [块菜单](jiange-document-table-header-menu-20261116.png)
- [320px 移动端](jiange-document-table-header-mobile-20261116.png)
- [匿名分享](jiange-document-table-header-public-20261116.png)
- [演示模式](jiange-document-table-header-presentation-20261116.png)

复现脚本为 `scripts/verify-document-table-header.mjs`，仅接受 `JIANGE_TABLE_TEST_URL` 和 `JIANGE_TABLE_CDP_URL` 指向的隔离本地服务，会创建合成账号、文档和匿名链接；`JIANGE_TABLE_SCREENSHOT_DIR` 可指定截图目录。

本次未完成飞书页面的逐像素对照。标题行吸顶随后已补充，见 `document-table-sticky-header-report-20261116.md`；完整单元格对齐、背景、富文本/图片、多格触屏选择及其并发安全仍未完成。
