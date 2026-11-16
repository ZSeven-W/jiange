# @jiange/doc-sdk

Headless document editing operations over `@jiange/collab`: block selection, text editing, formatting, split/join, table properties, clipboard and Markdown. It also exposes Jiange's existing bounded DOCX reader/writer over byte arrays, including its documented fidelity limits. No React, DOM, transport, storage or permission enforcement is included; parsing compressed Word files requires a host with `DecompressionStream("deflate-raw")`. This internal 0.1 model API is not a complete Word-compatible editor.

Build `@jiange/collab` and `@jiange/whiteboard-sdk` first, then run `pnpm --filter @jiange/doc-sdk build`. The packaged ESM output depends on those matching packages.
