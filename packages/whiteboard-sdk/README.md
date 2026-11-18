# @jiange/whiteboard-sdk

Headless graph, mind-map, stroke, history and viewport math shared with Jiange's whiteboard and flowchart editor. It does not render UI, upload assets, provide a server, or implement an independent collaborative transport. The existing graph-property conflict semantics are retained; this package alone does not make whiteboard edits a text CRDT.

Build with `pnpm --filter @jiange/whiteboard-sdk build`; `pnpm pack` emits ESM and TypeScript declarations. The package remains private.

## License

Free for personal and commercial use. If an enterprise modifies or creates derivative works from this SDK, it must publicly attribute Jiange SDK (`https://github.com/ZSeven-W/jiange`) as the source. See [LICENSE](../../LICENSE) for full terms.
