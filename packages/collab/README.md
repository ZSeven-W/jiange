# @jiange/collab

Headless TypeScript collaboration primitives used by Jiange: the document CRDT, transactions and undo, binary codecs, sync protocol and transport-independent `SyncClient`. It does not include a network server, authentication, a WebSocket lifecycle, or durable browser storage; applications must provide those adapters. See `spec/protocol.md` for compatibility and the deployment gates in `roadmap.md`.

Build with `pnpm --filter @jiange/collab build`. The workspace resolves the source entry; `pnpm pack` produces ESM JavaScript and declarations under `dist`. The package is private and is not published by this repository.
