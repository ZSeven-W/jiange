# 文档表格外部 HTML 粘贴验证

日期：2026-11-16。飞书[文档表格说明](https://www.feishu.cn/hc/zh-CN/articles/639833584167-%E5%9C%A8%E6%96%87%E6%A1%A3%E4%B8%AD%E6%8F%92%E5%85%A5%E8%A1%A8%E6%A0%BC)介绍了表格及格式功能；本次补充 Jiange 的外部数据粘贴能力，未据此宣称 Excel/WPS 或飞书全部行为一致。

## 实现

- 多格外部 HTML 表格的文字与纯文本一致时，识别受限的背景色、水平/垂直对齐以及行列合并；写入沿用现有格式粘贴、冲突检查和单步撤销/重做。格式与现有合并格冲突时拒绝操作。
- 使用纯 JavaScript 的 [parse5](https://github.com/inikulin/parse5) 解析数据，不插入外部 DOM，也不执行脚本或加载资源。限制输入大小、格数、标签数和嵌套深度；发现不支持的关键格式、多个表格、媒体或纯文本不一致时回退纯文本。可能丢失字体、边框等样式时显示提示。
- 受支持范围包括常见十六进制/RGB 背景色、有限颜色名、单类 CSS 规则及单元格属性；复杂 CSS 和不可识别的关键样式不会被当作完整格式。没有结构化换行或制表符的单格普通粘贴仍保留原来的光标内插入行为。

## 截图

- [LibreOffice 导出样例粘贴](jiange-document-table-external-paste-20261116.png)
- [部分格式提示](jiange-document-table-external-notice-20261116.png)
- [外部合并格粘贴](jiange-document-table-external-merged-20261116.png)
- [匿名阅读](jiange-document-table-external-public-20261116.png)
- [手机模拟视口](jiange-document-table-external-mobile-20261116.png)

## 验证

样例工作簿由 openpyxl 3.1.5 创建，再由 LibreOfficeDev 26.8.0.0.alpha0 的 Calc HTML 导出并去除行尾空白后保存为 `apps/web/src/editor/fixtures/libreoffice-table.html`；它是文件导出样例，不是从真实系统剪贴板捕获的 Excel/WPS 数据。隔离 PostgreSQL、合成账号、本地服务和 Chrome 验证了该样例与合并格的粘贴、双标签页同步、撤销重做、刷新、公开阅读和手机模拟；还验证 HTML 与纯文本不一致时回退，以及脚本和外部图片地址不执行、不加载。剪贴板事件使用 `DataTransfer` 模拟，没有修改用户系统剪贴板。

单元测试覆盖样式、规则优先级、透明背景、行分组、跨行合并、空尾行、形状或文本不一致、嵌套/媒体、恶意 CSS 与尺寸限制。原有 Jiange 格式粘贴、合并格粘贴和触屏选区浏览器回归通过；Web 全量 205 个测试文件、1104 个用例、类型检查和构建通过。

## 限制

未在 Microsoft Excel、WPS、真实系统剪贴板或实体手机上实测，也没有与飞书实页逐像素对照。字体、文字颜色、边框、公式、图片、附件、复杂 CSS/选择器及样式继承不能完整保留；不受支持的格式可能提示或回退纯文本。单次格式解析上限为 1000 格、512K 个 HTML UTF-16 代码单元和 256K 个纯文本 UTF-16 代码单元，模糊或不一致的数据不套用格式。结构与格式的在途并发仍可能竞争。测试数据库包含工作区原有未提交的文档类型迁移。构建主包因引入 HTML 解析器增加约 52 KiB gzip，后续可评估安全地延迟加载。
