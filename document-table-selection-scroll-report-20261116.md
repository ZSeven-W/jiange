# 文档表格拖选滚动验证（2026-11-16）

文档表格跨单元格拖选时，鼠标靠近表格横向滚动区域或文档纵向滚动区域的边缘会持续滚动，并延伸选区；向反方向拖动同样可用。松开鼠标后停止滚动，保持当前位置，并恢复表格焦点以便复制选区。单元格内选择文字的行为继续保留。

使用隔离 PostgreSQL、合成账号、真实 Go 服务和 Chrome 1440×900 测试了 25 行、12 列表格：向右拖选全部 12 列，向下拖选全部 25 行，向左及向上反向滚动，在中途松开后验证滚动位置不跳回且不再继续移动，并通过剪贴板事件验证所选内容；刷新后表格仍为 25×12。截图中的 390×844 为浏览器模拟视口，未验证真实手机的触屏拖选。

- [横向滚动与选区](jiange-document-table-scroll-horizontal-20261116.png)
- [纵向滚动与选区](jiange-document-table-scroll-vertical-20261116.png)
- [窄屏显示](jiange-document-table-scroll-mobile-20261116.png)

复现脚本为 `scripts/verify-document-table-selection.mjs`；需要分别通过 `JIANGE_TABLE_TEST_URL` 和 `JIANGE_TABLE_CDP_URL` 指向一次性本地应用及专用 Chrome 调试端口。脚本会注册合成账号并写入测试文档，截图输出到当前目录或 `JIANGE_TABLE_SCREENSHOT_DIR`。不要将测试服务指向现有数据库。

本次没有在登录后的飞书页面逐项比对拖选细节，也没有验证触屏拖选、浏览器外拖动或全部合并单元格场景；不能据此认定文档表格已完全对齐。
