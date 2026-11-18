# @jiange/doc-sdk

Headless document editing operations over `@jiange/collab`: block selection, text editing, formatting, split/join, table properties, column width and move models, clipboard and Markdown. It also exposes Jiange's existing bounded DOCX reader/writer over byte arrays, including its documented fidelity limits. No React, DOM, transport, storage or permission enforcement is included; parsing compressed Word files requires a host with `DecompressionStream("deflate-raw")`. Column layout snapshots detect already-observed conflicts, but callers must provide authoritative conditional commits when required. This internal 0.1 model API is not a complete Word-compatible editor.

Build `@jiange/collab`, `@jiange/whiteboard-sdk` and `@jiange/ooxml` first, then run `pnpm --filter @jiange/doc-sdk build`. The packaged ESM output depends on those matching packages.

The `@jiange/doc-sdk/column-archive-experimental` subpath contains an unstable identity-preserving column archive model. Its plans do not perform network writes, verify receipts, enforce permissions or persist recovery handles; hosts must supply those guarantees and scope any stored data to the current account and document.

## License

Free for personal and commercial use. If an enterprise modifies or creates derivative works from this SDK, it must publicly attribute Jiange SDK (`https://github.com/ZSeven-W/jiange`) as the source. See `LICENSE` (bundled in the package archive; repository root `LICENSE`) for full terms.
