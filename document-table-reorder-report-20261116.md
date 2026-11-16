# 文档表格行列拖动验证报告

日期：2026-11-16。参考[飞书官方文档表格说明](https://www.feishu.cn/hc/zh-CN/articles/639833584167-%E5%9C%A8%E6%96%87%E6%A1%A3%E4%B8%AD%E6%8F%92%E5%85%A5%E8%A1%A8%E6%A0%BC)中拖动单行、单列及多行多列的说明。本次在隔离的本机数据库、服务和 Chrome 中验证 Jiange；没有与登录后的当前飞书逐像素或逐操作对照。

## 本次实现与验证

- 行、列握把支持拖动、落点预览、Esc 取消，以及靠近边缘时自动滚动。拖动单行/单列、框选连续行、按住 Ctrl 或 Command 选择不相邻列后整体移动均已验证；Alt 加方向键也能移动所选行列。
- 移动时保留单元格内容、背景色、对齐、列宽和可保持完整的合并区域；拆散合并区域的落点会被拒绝。横向合并单元格随整行移动已通过浏览器验证，横向、纵向合并处的握把另有组件测试。
- 拖动后撤销、重做、刷新、另一协作者同步和公开阅读页已验证。对方在拖动期间修改数据或格式，且变化已经同步到本地时，本地拖动会取消或拒绝提交。
- 390×844 的 Chrome 触屏模拟验证了单行及连续多行拖动，已有触屏选区和单元格对齐脚本也通过。此为模拟触屏，未在真实手机或 Safari 上验证。
- 自动化：Web 端 205 个测试文件、1108 项测试通过；Web 构建和项目文件命名检查通过。构建仍提示部分 JS 分包超过 500 kB。

## 截图

截图均为 Jiange 本地页面，示例数据由测试脚本创建：

- [拖动行](jiange-document-table-reorder-row-drag-20261116.png) · [移动结果](jiange-document-table-reorder-row-result-20261116.png)
- [选择不相邻列](jiange-document-table-reorder-column-selection-20261116.png) · [拖动列](jiange-document-table-reorder-column-drag-20261116.png) · [列移动结果](jiange-document-table-reorder-column-result-20261116.png)
- [连续行移动](jiange-document-table-reorder-group-20261116.png) · [合并单元格随行移动](jiange-document-table-reorder-merged-row-20261116.png) · [拒绝拆散合并单元格](jiange-document-table-reorder-merge-conflict-20261116.png)
- [手机模拟拖动](jiange-document-table-reorder-mobile-drag-20261116.png) · [手机移动结果](jiange-document-table-reorder-mobile-result-20261116.png) · [手机连续行拖动](jiange-document-table-reorder-group-mobile-20261116.png)
- [横向边缘滚动](jiange-document-table-reorder-horizontal-scroll-20261116.png) · [纵向边缘滚动](jiange-document-table-reorder-vertical-scroll-20261116.png) · [公开阅读](jiange-document-table-reorder-public-20261116.png)

## 仍需补齐

1. 拖动的快照检查只覆盖提交前**已经收到**的变更，不是服务端原子条件写入；同时在途的结构、单元格和样式写入，以及旧客户端写入仍可能竞争，需要协议和事务级方案。
2. 不相邻握把多选目前用于整体移动，尚不支持对这些不连续区域批量设置格式或复制。合并区域中缺失握把的问题已在[补充验证](document-table-merged-grips-report-20261116.md)修复；表格横向滚动后行握把仍会随内容移出视口。
3. 与当前飞书在相同视口、数据、图标和悬停状态的实机逐项对照，以及真实手机、移动端键盘和 Safari 操作尚未完成，不能据此声称视觉或操作完全一致。
4. 表格富内容、其他编辑器能力及项目整体差距仍见 [差距调查](document-feishu-gap-audit-20261116.md) 和 [路线图](roadmap.md)。

本次浏览器验证运行于当时的工作区，其中包含既有未提交服务端文件和迁移；不能据此推断仅凭本次提交即可复现同一服务端状态。测试使用临时数据库及测试账号，没有更改用户已有文档。
