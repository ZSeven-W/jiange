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

## 9. 尚未实现（P2+）/ Not yet (P2+)
Awareness 消息、服务端定序 seq / ack、快照与墓碑 GC、列式压缩编码、撤销栈。
