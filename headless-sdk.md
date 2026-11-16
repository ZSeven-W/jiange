# Jiange Headless SDK 拆分

这些包把现有 Web 编辑器使用的模型和算法移到不依赖 React、DOM 或页面状态的 TypeScript 模块。Web 端通过兼容导出继续使用同一份实现，避免 SDK 与界面各维护一套模型。当前版本为内部 `0.1.0`、包标记为 private，尚未发布；API 和格式兼容性还不能视为稳定承诺。

| 包 | 当前提供 | 尚未提供 |
| --- | --- | --- |
| `@jiange/collab` | CRDT 文档、操作、事务、撤销、编解码、同步协议和传输无关的 `SyncClient` | 服务端、鉴权、网络连接生命周期、离线存储适配器；跨产品通用协同模型尚未完成 |
| `@jiange/doc-sdk` | 文档块/文字操作、表格属性、栏宽和同组移动模型、剪贴板模型、Markdown、现有 DOCX 字节导入导出 | 完整 Word 保真、图片上传和权限、UI；分栏模型本身不提供服务端条件提交，压缩 DOCX 解析需宿主提供 `DecompressionStream("deflate-raw")` |
| `@jiange/slides-sdk` | 页面与图形类型、布局、顺序、放映导航、形状几何和线条端点 | PPTX 读写、动画、图表、实时协作、服务端与渲染器 |
| `@jiange/sheet-sdk` | 当前实验网格、TSV、有限公式计算、同页复制引用调整，以及多工作表 XLSX 基础字节读写 | XLSX 样式/合并单元格完整保真、共享与数组公式、正式工作簿、可配置大表、权限、持久化和协作；预览默认范围 100×26 |
| `@jiange/whiteboard-sdk` | 画板/流程图对象、属性读写与冲突意图、思维导图、笔迹几何、历史和视口数学 | 渲染器、资源上传、独立协同传输及完整对象/文字 CRDT |

## 构建与验证

```bash
pnpm install
pnpm -r typecheck
pnpm -r build
pnpm -r test
pnpm test:sdk:pack
```

`pnpm test:sdk:pack` 会按依赖顺序构建五个 SDK 与内部共享 OOXML 包，用 `pnpm pack` 生成临时包，在隔离目录验证 Node ESM 加载、严格 NodeNext 类型检查以及基本模型操作；文档和表格包额外验证 DOCX/XLSX 字节往返。脚本使用系统 `tar`，结束时只清理自己创建的临时目录。包在工作区通过 `src` 提供开发入口；`pnpm pack` 使用 `publishConfig` 将入口切换至 `dist`。文档包依赖相同版本的协同包、白板包和内部 OOXML 包，表格包也依赖 OOXML 包；离开工作区使用时需要同时提供相应依赖。可选的 `JIANGE_XLSX_PYTHON=/path/to/python pnpm test:xlsx:interop` 使用已安装 OpenPyXL 的 Python 验证双向互通。

## 基本用法

```ts
import { Doc, ROOT, Tx } from "@jiange/collab";
import { splitBlock } from "@jiange/doc-sdk";
import { calculateSheet, writeXlsx, readXlsx } from "@jiange/sheet-sdk";
import { moveShapeOrder } from "@jiange/slides-sdk";
import { flowWrites, readFlow } from "@jiange/whiteboard-sdk";

const doc = new Doc(1);
const tx = new Tx(doc);
const block = tx.create("paragraph", null, ROOT);
tx.insert(block, 0, "协作指南");
splitBlock(tx, { b: block, o: 2 }); // 此例为单副本；当前拆段尚不能保证在途并发文字的顺序。

const values = calculateSheet({ "0:0": "2", "0:1": "=A1*3" });
// values["0:1"] === 6
const bytes = writeXlsx({ sheets: [{ name: "Sheet1", cells: [{ row: 0, col: 0, value: "示例" }] }] });
const imported = await readXlsx(bytes); // 使用前检查 imported.warnings
const ordered = moveShapeOrder([], "shape-id", "front");
const graph = readFlow(flowWrites({}, { theme: "feishu", nodes: [], edges: [] }));
```

协同 SDK 的 `UndoManager.markInsertionPoint()` 可为异步操作标记当前位置；宿主确认操作已持久化并在本地副本可见后，可调用 `insertMarkerAt(point, marker)` 把记录放在后续本地编辑之前。若用户在等待期间执行撤销/重做、锚点被淘汰或历史不再适用，该方法返回 `false`，宿主必须处理冲突；它本身不执行网络提交，也不会持久化历史。

协同宿主可将二进制传输接到 `SyncClient.open(send)` 和 `receive(bytes)`，断线调用 `close()` 并同时保存 `pendingOps()`、`pendingHistoryEpoch`、副本 ID 和拒绝状态；恢复时调用 `restore(clientId, ops, blocked, historyEpoch)`。v2 会话中历史代际不同或未知的草稿进入 `history_changed`，不得静默重发，宿主应提供账号隔离的备份和恢复流程，并在调用 `discardQuarantined()` 前持久化和验证备份；v1 会话没有代际信息，无法提供同等隔离保证。实际接入还需要实现会话鉴权、可靠存储、重连和权限变化处理。以上示例只演示本地模型，不会自动连接服务器。

## 集成边界

1. SDK 接受数据、返回操作或结果，不直接读取页面、打开连接、弹窗或访问用户剪贴板。
2. 账号、权限、网络、同步连接、断线重连、待确认操作持久化和 UI 保留在宿主；使用协同包时仍须遵守 `spec/protocol.md` 以及服务端升级、身份和权限门禁。
3. 保持当前数据和协议语义：抽包不等于为幻灯片或表格增加多人实时协作，也不等于已完成飞书功能或 UI 对齐。
4. 后续应先定义版本化的数据模型、稳定 API 与跨端测试，再补 PPTX 导入导出和 XLSX 的更多格式语义、各自的持久化/协同适配器、插件命令层和迁移方案；不能把实验表格或对象级后写覆盖称作完整 Office 或协同支持。

## 独立单元测试和覆盖率

五个公开的 headless SDK 均可在各自包目录独立运行 `pnpm test`；仓库根目录执行 `pnpm test:sdk:coverage` 可汇总源代码 V8 覆盖率，并对每个包执行语句及行覆盖率至少 85%、分支至少 75%、函数至少 80% 的最低门槛。文档、表格、幻灯片和白板的纯模型测试已从 Web 应用迁入对应 SDK，涉及浏览器、服务端和跨包集成的测试继续保留在应用层。

2026-11-16 本轮协同 SDK 本地覆盖率（语句 / 分支）为 96.79% / 89.26%；其他包的当前结果以 `pnpm test:sdk:coverage` 输出为准。当前 `SyncClient` 对实验性 `ttable` 操作、快照和待发送草稿一律停止同步并保留草稿；它尚不是支持表格 CRDT 的可用传输。上述数字不等于功能完整性或所有并发情形已验证；服务端条件提交、浏览器交互、实体设备和 DOCX/XLSX 与第三方软件的全部互通仍需各自的集成验证。内部共享 `@jiange/ooxml` 保留独立测试，不计入上述五个 SDK。
