# Changelog — @zseven-w/collab

## [0.2.0] - 2026-11-21

### Added & Changed
- Graduated Table CRDT (`@zseven-w/collab/table`) with Lamport ID allocator and binary wire codec.
- Added lightweight subpath adapters: `./ws` (WebSocket reconnect/heartbeat), `./storage` (Memory/IndexedDB offline draft storage), and `./ai-agent` (AI collaborator adapter).
- Marked package `sideEffects: false` and achieved 100% V8 unit test coverage.
