# @jiange/whiteboard-sdk

AI-native headless Whiteboard, Flowchart & MindMap SDK (`v0.2.0`) over `@jiange/ooxml`: unified `Board` Facade, bidirectional Mermaid diagrams, layered DAG auto-layout, alignment/distribution, pure-TS SVG rendering, DEFLATE `.xmind` import/export, freehand ink geometry, topology auditing (`verify()`), and self-describing AI tools.

## Install

```bash
npm install @jiange/whiteboard-sdk
```

- **Runtime dependencies**: `@jiange/ooxml` (0 third-party dependencies)
- **Bundle size**: ~36.8 KB gzip

## Features

- **`Board` Facade**: `Board.create`, `fromGraph`, `fromProps`, `fromMermaid`, `fromXmind`, `undo()`/`redo()`, token-budgeted `inspect()`, `query()`, atomic `apply(ops, { dryRun })`, and deterministic topology auditing `verify()`.
- **Mermaid & Layout**: Bidirectional `fromMermaid` / `toMermaid` (`flowchart`, `graph`, `mindmap`), layered DAG `autoLayout({ direction: "TB" | "LR", gapX, gapY })`, `alignNodes`, and `distributeNodes`.
- **Zero-DOM SVG & XMind**: `toSvg()` (`renderBoardToSvg`), sync `toXmind()` (`exportMindMapToXmind`), async DEFLATE `toXmindAsync()` (`exportMindMapToXmindAsync`), and `parseXmindToMindMap`.
- **Self-Describing AI Toolkit (`createWhiteboardTools`)**: 8 JSON-Schema tools (`board_inspect`, `board_query`, `board_apply`, `board_verify`, `board_auto_layout`, `board_export`, `board_undo`, `board_redo`).
- **Low-Level Primitives**: Flowchart property serialization (`readFlow`, `flowWrites`), mind-map tree operations, freehand ink scaling (`scaleInk`, `scaleSelectionProportionally`), comment anchors (`encodeFlowCommentAnchor`, `parseFlowCommentAnchor`), history stack, and viewport math.

## Quickstart

```ts
import { Board, createWhiteboardTools } from "@jiange/whiteboard-sdk";

const board = Board.fromMermaid(`
flowchart LR
  A[Client] --> B[API Gateway]
  B --> C[Jiange Engine]
`);

board.autoLayout({ direction: "LR", gapX: 60, gapY: 40 });

const tools = createWhiteboardTools(board);
const diagnostics = tools.execute("board_verify", {});
const svg = board.toSvg();
const mermaid = board.toMermaid();
const xmindBytes = await board.toXmindAsync();
void [diagnostics, svg, mermaid, xmindBytes];
```

## Subpath Exports

| Subpath | Contents |
| --- | --- |
| `@jiange/whiteboard-sdk` | Full barrel export (`Board`, `createWhiteboardTools`, Mermaid, SVG, XMind, mindmap, ink, viewport) |
| `@jiange/whiteboard-sdk/board` | `Board`, `BoardOp`, `BoardDiagnostic`, `BoardInspectResult`, `BoardApplyResult` |
| `@jiange/whiteboard-sdk/ai-tools` | `createWhiteboardTools` |
| `@jiange/whiteboard-sdk/mermaid` | `fromMermaid` |
| `@jiange/whiteboard-sdk/svg` | `renderBoardToSvg` |
| `@jiange/whiteboard-sdk/xmind` | `exportMindMapToXmind`, `exportMindMapToXmindAsync`, `parseXmindToMindMap`, `XmindError` |
| `@jiange/whiteboard-sdk/model` / `./mindmap` | `readFlow`, `flowWrites`, `FlowGraph`, `FlowNode`, `FlowEdge`, mind-map layout & tree helpers |
| `@jiange/whiteboard-sdk/ink-geometry` / `./comment-anchor` / `./history` / `./viewport` | Ink scaling (`scaleInk`, `scaleSelectionProportionally`), comment anchors, undo history, viewport math *(deprecated camelCase alias: `./inkGeometry`)* |

## Documentation

Full SDK documentation and recipes are available at [`https://github.com/ZSeven-W/jiange`](https://github.com/ZSeven-W/jiange) (see `sdk-docs/headless-sdks.md`).

## License

Free for personal and commercial use. If an enterprise modifies or creates derivative works from this SDK, it must publicly attribute Jiange SDK (`https://github.com/ZSeven-W/jiange`) as the source. See the bundled `LICENSE` file (repository root `LICENSE`) for full terms.
