# 文档表格列宽与 Word 互通验证

日期：2026-11-16。该报告只覆盖本轮列宽实现和截图，不代表全部功能或界面已经与飞书一致。

## 实现

- 有明确列宽的文档表格导出为 Word 固定网格；合并单元格的宽度为其跨越列宽之和。依据 [Microsoft 对 Word 表格网格](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.tablegrid?view=openxml-3.0.1)和[宽度单位](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.tablewidthunitvalues?view=openxml-3.0.1)的定义进行转换。
- Word 固定网格的有效宽度导入为文档列宽，保留行尾省略的空白网格列；自动布局、不一致或超出页面等情况不保证一致，并提示可能发生变化。
- 编辑态表格操作列不再挤压数据列；公开阅读与演示视图使用相同的列宽规则。损坏的列宽数据回退到默认尺寸，避免影响文档打开。

## 截图

- [桌面：Word 导入后的列宽](jiange-document-word-width-20261116.png)
- [桌面：拖动调整后](jiange-document-word-width-resized-20261116.png)
- [手机模拟视口：表格左侧](jiange-document-word-width-mobile-20261116.png)
- [手机模拟视口：横向滚动后](jiange-document-word-width-mobile-scroll-20261116.png)
- [公开阅读：调整后的列宽](jiange-document-word-width-public-20261116.png)
- [界面下载的 Word 经 LibreOffice 渲染](jiange-document-word-width-libreoffice-20261116.png)

## 验证范围

使用隔离数据库和账号，导入含组合合并的 Word 示例，浏览器测量两张表的实际列宽分别为 180/120/240 和 140/180/160 像素；拖动第二张表首列至 170 像素，刷新、导出及公开阅读后仍为 170/180/160。python-docx 独立读取导出文件，LibreOffice 另存 DOCX 再导入均验证了结构和列宽。截图中的 Word 页面由 LibreOffice 渲染，并配置了本机中文字体。拖选、标题行吸顶、触屏滚动和标题操作的浏览器回归通过。SDK 覆盖率检查并行运行时一次触发协作性能测试阈值（17.18 ms/次，要求小于 16 ms），减少并行负载后重跑通过。

自动布局、单元格自身的冲突首选宽度、窄于编辑器最小宽度、超出 Word 正文的表格和复杂第三方布局仍可能产生显示差异；真实 Microsoft Word、WPS 和手机尚未在本轮验证。多人同时调整同一表格列宽仍有后写覆盖限制。
