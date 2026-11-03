# Jiange 协同模型与编码规范 v1 / Collaboration model & encoding spec v1

TypeScript 实现在 `packages/collab`，Go 实现在 `server/collab`。两边必须在**字节**和**物化状态**上完全一致，由 `spec/vectors/*.json` 保证。
The TypeScript (`packages/collab`) and Go (`server/collab`) implementations must agree byte-for-byte and state-for-state; `spec/vectors` enforce this.

## 1. 标识与时钟 / IDs and clocks
- `OpId = (client, clock)`；`clock` 是 Lamport 时钟。全序：先比 `clock`，再比 `client`。
- `(0,0)` 是 `ROOT`：块树的根，也是每个文本序列的虚拟根。
- 本地新操作：`clock = max_seen + 1`；`tins` 插入 n 个字符消耗 n 个时钟，第 i 个字符的 id 为 `(client, clock+i)`。
- 字符以 Unicode 码点为单位（TS `[...s]`，Go `[]rune`）。

## 2. 操作 / Operations
| tag | t | 字段 | 语义 |
|---|---|---|---|
| 1 | `bcreate` | id, parent, pos, type | 创建块；块 id = op id；`type` 作为 prop `type` 写入（时间戳 = id） |
| 2 | `bmove` | id, block, parent, pos | 位置寄存器 `(parent,pos)` LWW |
| 3 | `bset` | id, block, key, value | prop 寄存器 LWW |
| 4 | `bdel` | id, block | 墓碑；删除胜出，子树隐藏 |
| 5 | `tins` | id, block, parent, side, text | Fugue 树插入：首字符挂在 `parent` 的左(0)/右(1)子列表，后续字符依次为前一字符的右孩子 |
| 6 | `tdel` | id, block, target, len | 标记 `(target.client, target.clock … +len-1)` 为墓碑 |
| 7 | `mark` | id, block, key, value?, start, end | Peritext 式区间标记；value 为空表示移除该格式 |

## 3. 文本序列 (Fugue 风格) / Text sequence
- 每个字符节点有 `left` 与 `right` 子列表，兄弟按 OpId 升序。
- 遍历顺序：左子树们 → 节点 → 右子树们（含墓碑）= 全序。
- 本地在可见下标 `i` 插入：`L` = 第 `i-1` 个可见字符（或 ROOT）。若 `L` 没有右孩子 → 作为 `L` 的右孩子；否则令 `R` = 全序中 `L` 的下一个元素，作为 `R` 的左孩子。

## 4. 标记 / Marks
- 锚点 `{char, side}`：side 0 = 字符之前，1 = 字符之后。槽位 `slot = 4*idx(char) + (side ? 2 : 0)`，字符位置 `4*idx + 1`。
- 字符被标记覆盖当且仅当 `slot(start) < 4*idx+1 < slot(end)`。同一 key 多个覆盖时取 OpId 最大者；其 value 为空则无格式。
- 本地 `format(from,to)` 产生 `start = before(chars[from])`，`end = after(chars[to-1])`（不向两端扩展）。

**Peritext 扩展规则**：标记起点锚在首字符之前（side 0）。可扩展标记（bold/italic/underline/strike/color）终点锚在下一个字符之前（side 0），位于块尾时用哨兵 `END = (ROOT, side 0)`，其槽位视为 +∞；不可扩展标记（link/code）终点锚在末字符之后（side 1）。

## 5. 块树 / Block tree
- 子块按 `(pos, id)` 排序，`pos` 为分数索引字符串，按字节序比较。
- 有效父块：沿父链上溯；遇到缺失或已删除的祖先 → 隐藏；遇到环 → 该块挂到 ROOT 下。

## 6. 因果缓冲 / Causal buffering
操作在依赖缺失时先缓存（目标块不存在；`tins` 的父字符；`tdel` 的目标；`mark` 的锚点字符），依赖满足后再应用。重复操作被忽略，因此投递可以乱序、可以重复。

## 7. 二进制编码 / Encoding
```
batch := 0x4a 0x01 uvar(count) op*
op    := u8(tag) id fields...
id    := uvar(client) uvar(clock)
str   := uvar(byteLen) utf8
uvar  := unsigned LEB128 (≤ 2^53-1)
side  := u8 (0|1)
mark.value := u8(0) | u8(1) str
```

## 8. 物化视图 / Materialized view
`view() = { blocks: [{ id:"c:k", parent:"c:k", type, props, spans:[{text, marks}] }] }`，按深度优先、兄弟有序输出；相邻且标记相同的字符合并为一个 span。该 JSON 就是跨语言比对的依据。

## 9. 状态编码 / State encoding (snapshots)
`0x4a 0x53 0x01 uvar(lamport) uvar(nBlocks) block*`。块按 id 排序；每块：
`id parent str(pos) id(posTs) u8(deleted) uvar(nProps) (str key, str value, id ts)* uvar(nChars) char* uvar(nMarks) mark*`。
属性按 key 字节序；字符按 Fugue 树先序（节点、左子树、右子树），每个字符
`id u8(side) uvar(parentIdx: 0 = 根, 否则 1 起的先序下标) u8(deleted) str(ch)`；标记按 id 排序。
TS 与 Go 对同一操作集必须产出逐字节相同的状态（`spec/vectors/state.json`）。

## 10. 同步协议 / Sync protocol (WebSocket `GET /api/sync`, cookie auth)
每个二进制帧一条消息，首字节为类型 / one message per binary frame:

| 方向 | 类型 | 载荷 |
|---|---|---|
| C→S | `0x01 HELLO` | uvar docId, uvar clientId (0 = 申请新的), uvar lastSeq |
| C→S | `0x02 OPS` | bytes(op batch §7) |
| C→S | `0x03 ACK` | uvar seq — 已应用到的序号 |
| C→S | `0x04 AWARE` | str json（光标/身份，≤ 4 KiB） |
| S→C | `0x11 WELCOME` | uvar clientId, uvar headSeq, u8 hasSnap, [uvar snapSeq, bytes state] |
| S→C | `0x12 OPS` | uvar firstSeq, bytes(batch) — 序号连续 |
| S→C | `0x13 ACK` | uvar firstSeq, uvar count — 发送者自己的批次获得的序号；重复操作不计入 |
| S→C | `0x14 AWARE` | uvar clientId, str json（"" = 离开） |
| S→C | `0x15 ERROR` | str code, str message |

- 服务端只做鉴权、校验、定序、持久化与广播，不做 transform。op 的 `id.client` 必须是发给该用户、该文档的副本号，否则断开连接。
- 序号由 `doc_heads` 行锁分配，跨实例全序且无空洞；`doc_ops (doc_id, client_id, clock)` 唯一，重发幂等。
- 重连：客户端带 `lastSeq`，服务端补发之后的操作；若 `lastSeq` 早于最新快照则先下发快照。客户端在确认任何新序号前先重发全部未确认的本地操作。
- 因果未就绪（引用未知操作）的 op 被拒绝并返回 `not_ready`，其余照常 ACK。
- 多实例：追加后 `NOTIFY jiange_ops 'docId:head'`；各实例 `LISTEN` 后从库中补齐并按序广播。

## 11. 快照与墓碑回收 / Snapshots & GC
每累计约 200 个操作生成快照。水位线 horizon = 近 30 天活跃副本已确认序号（`doc_clients.acked_seq`）的最小值。
快照 = 上一快照 + 至 horizon 的操作，然后 Compact：移除不再被标记锚点引用的叶子墓碑字符，并移除已删除块。
因为客户端先重发未确认操作再确认，horizon 之前的墓碑不会再被新操作引用。超过 30 天未出现的副本重连时
其未确认操作若引用了已回收的墓碑会被丢弃（客户端计入 `droppedOnResync`）。

## 12. 尚未实现 / Not yet
列式压缩编码、撤销栈、按块的权限、快照版本（`is_version`）的 UI。
