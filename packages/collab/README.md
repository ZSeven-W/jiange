# @jiange/collab

Zero-dependency TypeScript CRDT & real-time collaboration kernel (`v0.2.0`) powering Jiange's collaborative editors and AI agents.

Byte-for-byte wire-compatible with Jiange's Go collaboration kernel (`spec/vectors`). Runs in Node.js, Edge runtimes, Web Workers, and browsers.

## Install

```bash
npm install @jiange/collab
```

- **Runtime dependencies**: `0`
- **Bundle size**: ~35.1 KB gzip (modular subpaths are tree-shakeable)

## Features

- **Document CRDT (`@jiange/collab`)**: OpId/Lamport clock, Fugue text sequence, block tree LWW + cycle-safe move, Peritext rich-text marks, fractional indexing (`keyBetween`), compact binary op & protocol codecs (`encodeOps`, `decodeOps`, `encodeClientMsg`, `decodeServerMsg`), transport-independent `SyncClient`, and marker-aware `UndoManager`.
- **Table CRDT (`@jiange/collab/table`)**: `CollabTable` (with Lamport `TableIdAllocator`) and binary `ttable` wire codec (`encodeTableOps`, `decodeTableOps`).
- **WebSocket Sync Adapter (`@jiange/collab/ws`)**: `WebSocketSyncAdapter` with exponential backoff reconnect, heartbeat ping, and offline outgoing frame queue.
- **Offline Draft Storage (`@jiange/collab/storage`)**: `DraftStorageAdapter` contract with built-in `MemoryDraftStorage` (Node/Edge/tests) and zero-dependency `IndexedDbDraftStorage` (browsers).
- **AI Collaborator Session (`@jiange/collab/ai-agent`)**: `AiCollabSession` enabling AI agents to join CRDT rooms as first-class peers with dedicated `clientId`, awareness presence (`idle` | `thinking` | `editing`), and atomic wire-encoded op batches.

## Quickstart

```ts
import { Doc, Tx, ROOT, SyncClient, UndoManager } from "@jiange/collab";
import { CollabTable, TableIdAllocator, encodeTableOps, decodeTableOps } from "@jiange/collab/table";
import { WebSocketSyncAdapter } from "@jiange/collab/ws";
import { MemoryDraftStorage } from "@jiange/collab/storage";
import { AiCollabSession } from "@jiange/collab/ai-agent";

// 1. Core CRDT document + transaction + undo
const doc = new Doc(1);
const tx = new Tx(doc);
const p = tx.create("paragraph", null, ROOT);
tx.insert(p, 0, "Hello Jiange Collab");

const sync = new SyncClient(1);
const history = new UndoManager();
void [sync, history];

// 2. Table CRDT & binary codec
const table = new CollabTable();
const alloc = new TableIdAllocator(1, doc);
const wire = encodeTableOps([]);
decodeTableOps(wire);
void [table, alloc];

// 3. AI Agent collaborative session
const ai = new AiCollabSession({
  agentId: "agent-writer",
  agentName: "Jiange AI",
  clientId: 9001,
  initialState: doc.saveState(),
  onEmitOps: (ops, encoded) => console.log("emitted ops:", ops.length, encoded.byteLength),
});
ai.appendParagraph("Drafted collaboratively by AI.");

// 4. Optional WebSocket adapter & offline draft storage
const ws = new WebSocketSyncAdapter({ url: "wss://example.com/sync/doc-1", heartbeatIntervalMs: 15_000 });
const drafts = new MemoryDraftStorage();
await drafts.save({ docKey: "doc-1", snapshot: doc.saveState(), pendingOps: [], updatedAt: Date.now() });
void ws;
```

## Subpath Exports

| Subpath | Contents |
| --- | --- |
| `@jiange/collab` | `Doc`, `Tx`, `ROOT`, `OpId`, `Op`, `SyncClient`, `UndoManager`, `encodeOps`, `decodeOps`, `encodeClientMsg`, `decodeServerMsg`, `keyBetween`, `randomSession`, `buildScenarios` |
| `@jiange/collab/table` | `CollabTable` (`ExperimentalTable`), `TableIdAllocator`, `encodeTableOps`, `decodeTableOps`, `DEFAULT_TABLE_LIMITS`, `validTableMarkValue` |
| `@jiange/collab/ws` | `WebSocketSyncAdapter`, `WebSocketSyncOptions`, `WebSocketLike`, `WsConnectionState` |
| `@jiange/collab/storage` | `DraftStorageAdapter`, `StoredDraft`, `MemoryDraftStorage`, `IndexedDbDraftStorage` |
| `@jiange/collab/ai-agent` | `AiCollabSession`, `AiAwarenessState`, `AiPresenceStatus`, `AiCollabBatchResult` |

## Documentation

Full SDK documentation, protocol guides, and architecture references are available at [`https://github.com/ZSeven-W/jiange`](https://github.com/ZSeven-W/jiange) (see `sdk-docs/headless-sdks.md`).

## License

Free for personal and commercial use. If an enterprise modifies or creates derivative works from this SDK, it must publicly attribute Jiange SDK (`https://github.com/ZSeven-W/jiange`) as the source. See the bundled `LICENSE` file (repository root `LICENSE`) for full terms.
