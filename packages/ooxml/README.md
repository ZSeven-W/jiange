# @jiange/ooxml

Internal headless ZIP and XML utilities shared by Jiange's OOXML-capable SDKs (`@jiange/doc-sdk`, `@jiange/sheet-sdk`, `@jiange/slides-sdk`, `@jiange/whiteboard-sdk`).

- **ZIP**: synchronous `createZip` (STORE) and asynchronous `createZipAsync` (raw DEFLATE via `CompressionStream("deflate-raw")` with automatic STORE fallback when smaller or unsupported). Reading (`listZip` / `readZipEntry`) supports STORE and DEFLATE via `DecompressionStream("deflate-raw")`, checks CRC-32, and enforces caller-supplied inflated byte limits.
- **XML**: bounded, DTD-rejecting XML parser (`parseXml`) and safe XML escaping (`escapeXml`).
- **Zero third-party runtime dependencies**, pure ES2022 TypeScript.

## License

Free for personal and commercial use. If an enterprise modifies or creates derivative works from this SDK, it must publicly attribute Jiange SDK (`https://github.com/ZSeven-W/jiange`) as the source. See `LICENSE` (bundled in the package archive; repository root `LICENSE`) for full terms.
