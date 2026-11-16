# XLSX SDK 验证（2026-11-16）

表格 SDK 新增受限的 XLSX 字节读取和生成。它不是完整的 Excel 实现：能力已接入普通表格开发预览，尚未接入工作簿存储或正式页面入口。

- [中文示例 XLSX](jiange-sdk-xlsx-sample-20261116.xlsx)：由 SDK 生成，含两张表、中文、数字、布尔、公式、缓存值和以 `=` 开头的普通文本；OpenPyXL 3.1.5 独立读取并核对了数据类型与内容。
- [英文渲染示例 XLSX](jiange-sdk-xlsx-render-sample-20261116.xlsx) 与 [LibreOffice 渲染图](jiange-sdk-xlsx-render-20261116.png)：LibreOfficeDev 26.8 无界面打开并导出 PDF，图中公式合计为 16.5。这是文件渲染图，不是 Jiange 或 Excel 界面截图。当前渲染环境的中文字体显示异常；对照 OpenPyXL 自建文件也存在同样问题，因此渲染图使用英文，中文内容仅通过 OpenPyXL 数据读取验证。
- SDK 读取 OpenPyXL 生成的压缩 XLSX 后再导出，由 OpenPyXL 验证工作表、数值、布尔、错误值及公式；也读取了 LibreOffice 另存生成的 XLSX。格式损失通过 `warnings` 返回。可用已安装 OpenPyXL 的 Python 执行 `JIANGE_XLSX_PYTHON=/path/to/python pnpm test:xlsx:interop` 复验 OpenPyXL 双向数据。

读取限制：压缩文件最多 20 MiB、单个 XML 部件最多 20 MiB、展开总量最多 64 MiB、100 张表、50,000 个单元格；不访问外部关系。样式、合并区域、图表及其他工作表元数据不能完整保留，会产生警告；共享/数组/数据表公式、ISO 日期单元格、宏工作簿和图表工作表等无法安全表示的内容会报错。导出文件最多 20 MiB；导出不计算公式，只按调用者提供的缓存值写入并请求表格应用重算。空字符串公式缓存存在兼容歧义，导出时需省略该缓存；导入时会报告该缓存未保留。真实 Excel/WPS 和手机端尚未验证。

## 开发预览的浏览器验证

Chrome 无界面模式在 `1440×900` 和模拟 `390×844` 视口验证；这些是 Jiange 开发预览的真实浏览器截图，不是飞书参考截图，也不是手机真机测试：

- [导入确认和损失提示](jiange-xlsx-preview-import-20261116.png)
- [导入后的桌面预览](jiange-xlsx-preview-20261116.png)
- [导入后的窄屏预览](jiange-xlsx-preview-mobile-20261116.png)
- [窄屏导入确认](jiange-xlsx-preview-import-mobile-20261116.png)

测试导入 OpenPyXL 创建的单工作表文件：取消导入后原内容未变，确认后公式显示 14；随后从浏览器下载 XLSX，并用 OpenPyXL 核对中文、数字、布尔和公式。多工作表文件在浏览器中拒绝，原内容未变。导入前确认会替换当前内容并清空撤销记录；刷新页面后数据丢失。预览只接受单工作表、100 行和 26 列范围内的数据，以 `=` 开头的普通文本因不能安全区分公式而拒绝导入。未修改的导入标量保留类型，公式缓存不复用；已编辑单元格按文本或数字重新推断类型。预览公式计算仅支持有限语法，警告不代表完整保真。
