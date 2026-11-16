# 文档表格行列插入与删除验证

日期：2026-11-16。本轮将单行列插入、菜单删除、连续行列批量删除，以及通过 Tab 新增行接入稳定行列 ID；不再因为位置变化重写其余单元格的文字和格式。新行列使用文档操作 ID 生成身份，删除后保留对应单元格寄存器，以便处理延迟写入和安全撤销。旧文本表格在首次结构操作前按既有规则迁移。

## 验证

- 两个 Chrome 标签页使用临时数据库：暂存第二窗口的写入帧，先插入或删除行列，再释放写入，检查存活单元格的文字与颜色仍跟随原行列。对已删除行的迟到文字不会使该行重新出现；通过测试文档的版本快照确认该文字仍保存在隐藏寄存器中，冲突撤销被阻止。
- 验证连续多行及多列删除、列宽和填色保留、合并区域内插入及删除非锚点行、拆分、旧表格首次迁移、Tab 新增行与连续撤销/重做；移动端使用 390×844 Chrome 模拟触屏验证插入和批量删除。
- Word 导出再导入、服务端表格投影测试通过；Web 端 206 个测试文件、1117 项测试和构建通过。五个 headless SDK 的覆盖率门禁与打包后的 Node ESM / NodeNext 类型检查通过。

## 截图

- [插入行后延迟编辑跟随原单元格](jiange-document-table-stable-insert-delayed-20261116.png)
- [删除行后存活内容及远端修改](jiange-document-table-stable-delete-survivor-20261116.png)
- [插入列后延迟编辑](jiange-document-table-stable-insert-column-20261116.png)
- [连续多行删除](jiange-document-table-stable-bulk-rows-20261116.png)
- [Tab 新增行](jiange-document-table-stable-tab-append-20261116.png)
- [合并区域内插入](jiange-document-table-stable-merged-insert-20261116.png)
- [手机模拟：插入行](jiange-document-table-stable-structure-mobile-insert-20261116.png) · [多行选择](jiange-document-table-stable-structure-mobile-selection-20261116.png) · [删除结果](jiange-document-table-stable-structure-mobile-result-20261116.png)

## 仍需完成

行列列表、合并关系及列宽仍是整体后写胜出：同时插入或删除同一轴可能覆盖结构，旧客户端和镜像修复也仍有竞争边界。被删除轴的数据目前仅作为隐藏寄存器保留，没有面向用户的单独恢复界面；并发改动后撤销可能被保守阻止。删除穿过合并区域的锚点行或列时，已支持迁移可见文字与格式；隐藏内容或格式冲突时会拒绝覆盖，详见[锚点验证](document-table-merged-anchor-report-20261116.md)。飞书实际语义和在途并发仍需核验。富文本、图片、附件和完整表格 CRDT 尚未实现。

截图来自 Jiange 本地页面，并非真实飞书逐像素对照；手机为浏览器模拟，未用真机或 Safari 验证。测试使用临时数据库和账号，运行的本地服务包含工作区既有未提交的服务端文件及迁移。
