# 文档表格移动端工具栏验证（2026-11-16）

飞书的[文档表格说明](https://www.feishu.cn/hc/zh-CN/articles/639833584167-%E5%9C%A8%E6%96%87%E6%A1%A3%E4%B8%AD%E6%8F%92%E5%85%A5%E8%A1%A8%E6%A0%BC)描述了单元格内容编辑及选中后的工具栏。当前 Jiange 仅支持文本型单元格，本次调整没有实现该说明中的全部内容类型或移动端多格选择。

此前窄屏下工具栏悬浮在表格上方，会盖住作者和修改时间。本次在小屏将工具栏放入表格上方的正常布局，放大操作按钮，同时去掉为桌面悬停控件预留的边距，让表格滚动区域利用完整正文宽度；桌面工具栏仍保持原有位置。

使用隔离 PostgreSQL、合成账号、真实 Go 服务与 Chrome 触摸模拟验证：320×720 和 390×844 下工具栏与作者行、表格均不重叠；390 宽度下实际派发触摸事件新增一行、编辑单元格、横向和纵向滑动，刷新后内容与新增行仍在；另用程序化鼠标事件建立多格选区，检查其工具栏在 320 宽度下没有裁切。桌面拖选、自动滚动和复制选区的浏览器回归通过。截图与触摸事件均来自模拟器，未在实体手机或已登录飞书移动端比对，不能说明触屏多格选择或键盘弹出时的体验已对齐。

- [390px 工具栏和编辑](jiange-document-table-mobile-toolbar-20261116.png)
- [390px 横向滑动](jiange-document-table-mobile-swipe-20261116.png)
- [320px 窄屏](jiange-document-table-mobile-320-20261116.png)

复现：在隔离环境启动应用与专用 Chrome 调试端口，分别设置 `JIANGE_TABLE_TEST_URL` 和 `JIANGE_TABLE_CDP_URL` 后运行 `node scripts/verify-document-table-touch.mjs`；脚本会创建合成账号和测试文档。可通过 `JIANGE_TABLE_SCREENSHOT_DIR` 指定截图目录。
