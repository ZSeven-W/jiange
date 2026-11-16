# Word 表格导入导出验证报告

日期：2026-11-16。该工作补充文档表格的 Word 互通，不能代表全部飞书文档能力或界面已经对齐。

## 本次调整

- 导出时根据文档真实设置生成普通行、标题行和标题列；普通首行不再被误设为重复标题行。
- 使用 Word 的网格跨度和纵向合并表示横向、纵向及组合矩形合并；导入时还原为文档表格结构。
- 合并区域若包含被覆盖的非空文字，导出时拆分该区域、保留各格文字并提示；Word 纵向合并续接格若带文字，导入时也会拆分并提示，避免丢失。旧式水平合并、复杂的多行标题和未识别设置会提示限制。
- Word 导入时，仅对 Jiange 自己的表格样式恢复标题列；第三方文件的首列样式不一定表示标题列，不直接推断。

实现参考 Microsoft 对 [纵向合并](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.verticalmerge?view=openxml-3.0.1)、[重复标题行](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.tableheader?view=openxml-3.0.1) 和 [表格样式标志](https://learn.microsoft.com/en-us/previous-versions/office/developer/office-2003/aa173811%28v%3Doffice.11%29) 的说明。

## 截图

- [Jiange 桌面：导入后的表格](jiange-document-word-table-import-20261116.png)
- [Jiange 模拟手机：导入后的表格](jiange-document-word-table-import-mobile-20261116.png)
- [Jiange 导出文件经 LibreOffice 渲染](jiange-document-word-table-libreoffice-20261116.png)

第三张图由 Jiange 界面实际下载的 Word 文件经 LibreOffice 转 PDF 后生成；为正确渲染中文，测试环境配置了本机字体。截图不是飞书或 Microsoft Word 的实机截图。

## 验证与限制

- SDK 单元测试检查首行/首列的四种组合、二维合并、越界或含隐藏文字的合并、第三方续接格含文字及不支持的旧式合并。
- `scripts/verify-document-docx-table.ts` 使用 python-docx 读取 Jiange 文件并生成第三方 Word 文件；还使用 LibreOffice 另存 DOCX，再验证单元格文字、合并及标题设置。
- `scripts/verify-document-docx-table-ui.mjs` 在隔离账号和数据库中通过界面导入 DOCX、检查结构及刷新持久化，再从界面导出；手机截图为 390 × 844 模拟视口。
- 表格的自定义列宽、单元格富文本、图片与复杂样式仍未完整转换，已有损失提示；不保证复杂第三方 Word 文件中的全部格式。未对 Microsoft Word、WPS 或真实手机做本轮验收。
