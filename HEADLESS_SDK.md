# Jiange Headless SDK 拆分

这些包把现有 Web 编辑器使用的模型和算法移到不依赖 React、DOM 或页面状态的 TypeScript 模块。Web 端通过兼容导出继续使用同一份实现，避免 SDK 与界面各维护一套模型。当前版本为内部 `0.1.0`、包标记为 private，尚未发布；API 和格式兼容性还不能视为稳定承诺。

| 包 | 当前提供 | 尚未提供 |
| --- | --- | --- |
| `@jiange/collab` | CRDT 文档、操作、事务、撤销、编解码、同步协议和传输无关的 `SyncClient` | 服务端、鉴权、网络连接生命周期、离线存储适配器；跨产品通用协同模型尚未完成 |
| `@jiange/doc-sdk` | 文档块/文字操作、表格属性、剪贴板模型、Markdown、现有 DOCX 字节导入导出 | 完整 Word 保真、图片上传和权限、UI；压缩 DOCX 解析需宿主提供 `DecompressionStream("deflate-raw")` |
| `@jiange/slides-sdk` | 页面与图形类型、布局、顺序、放映导航、形状几何和线条端点 | PPTX 读写、动画、图表、实时协作、服务端与渲染器 |
| `@jiange/sheet-sdk` | 当前实验网格、TSV、有限公式计算和同页复制引用调整 | XLSX 读写、正式工作簿、可配置大表、权限、持久化和协作；当前默认范围 100×26 |
| `@jiange/whiteboard-sdk` | 画板/流程图对象、属性读写与冲突意图、思维导图、笔迹几何、历史和视口数学 | 渲染器、资源上传、独立协同传输及完整对象/文字 CRDT |

## 构建与验证

```bash
pnpm install
pnpm -r typecheck
pnpm -r build
pnpm -r test
pnpm test:sdk:pack
```

`pnpm test:sdk:pack` 会按依赖顺序构建五个包，用 `pnpm pack` 生成临时包，在隔离目录验证 Node ESM 加载、严格 NodeNext 类型检查以及基本模型操作；文档包额外验证 DOCX 字节往返。脚本使用系统 `tar`，结束时只清理自己创建的临时目录。包在工作区通过 `src` 提供开发入口；`pnpm pack` 使用 `publishConfig` 将入口切换至 `dist`。文档包依赖相同版本的协同包和白板包，离开工作区使用时需要同时提供它们。

## 基本用法

```ts
import { Doc, ROOT, Tx } from "@jiange/collab";
import { splitBlock } from "@jiange/doc-sdk";
import { calculateSheet } from "@jiange/sheet-sdk";
import { moveShapeOrder } from "@jiange/slides-sdk";
import { flowWrites, readFlow } from "@jiange/whiteboard-sdk";

const doc = new Doc(1);
const tx = new Tx(doc);
const block = tx.create("paragraph", null, ROOT);
tx.insert(block, 0, "协作指南");
splitBlock(tx, { b: block, o: 2 });

const values = calculateSheet({ "0:0": "2", "0:1": "=A1*3" });
// values["0:1"] === 6
const ordered = moveShapeOrder([], "shape-id", "front");
const graph = readFlow(flowWrites({}, { theme: "feishu", nodes: [], edges: [] }));
```

协同宿主可将二进制传输接到 `SyncClient.open(send)` 和 `receive(bytes)`，断线调用 `close()` 并保存 `pendingOps()`；实际接入还需要实现会话鉴权、可靠存储、重连和权限变化处理。以上示例只演示本地模型，不会自动连接服务器。

## 集成边界

1. SDK 接受数据、返回操作或结果，不直接读取页面、打开连接、弹窗或访问用户剪贴板。
2. 账号、权限、网络、同步连接、断线重连、待确认操作持久化和 UI 保留在宿主；使用协同包时仍须遵守 `spec/PROTOCOL.md` 以及服务端升级、身份和权限门禁。
3. 保持当前数据和协议语义：抽包不等于为幻灯片或表格增加多人实时协作，也不等于已完成飞书功能或 UI 对齐。
4. 后续应先定义版本化的数据模型、稳定 API 与跨端测试，再补 PPTX/XLSX 导入导出、各自的持久化/协同适配器、插件命令层和迁移方案；不能把实验表格或对象级后写覆盖称作完整 Office 或协同支持。
