# @jiange/ooxml

Zero-dependency headless ZIP and XML foundation (`v0.2.0`) shared by Jiange's OOXML-capable SDKs (`@jiange/sheet-sdk`, `@jiange/doc-sdk`, `@jiange/slides-sdk`, `@jiange/whiteboard-sdk`).

Runs identically in Node.js 18+, Edge runtimes, Web Workers, and modern browsers.

## Install

```bash
npm install @jiange/ooxml
```

- **Runtime dependencies**: `0`
- **Bundle size**: ~4.9 KB gzip

## Features

- **ZIP creation & inspection**:
  - Synchronous `createZip` (STORE) for zero-latency environments.
  - Asynchronous `createZipAsync` with raw DEFLATE via Web Streams `CompressionStream("deflate-raw")` (automatic STORE fallback when smaller or unsupported).
  - Bounded `listZip` and `readZipEntry` supporting STORE and DEFLATE (`DecompressionStream("deflate-raw")`), CRC-32 integrity validation, Zip-Bomb inflated byte caps, and configurable max-entry limits (`ZIP_DEFAULT_MAX_ENTRIES`).
- **Bounded, DTD-rejecting XML parser**:
  - `parseXml` rejects `<!DOCTYPE` / entity expansion attacks and enforces `maxNodes` bounds.
  - Tree helpers (`child`, `children`, `textContent`) and safe escaping (`escapeXml`).

## Quickstart

```ts
import {
  createZipAsync,
  listZip,
  readZipEntry,
  parseXml,
  child,
  textContent,
  escapeXml,
} from "@jiange/ooxml";

const xml = `<book><title>${escapeXml("Jiange & Co.")}</title></book>`;
const archive = await createZipAsync([
  { name: "meta.xml", data: new TextEncoder().encode(xml) },
]);

const entries = listZip(archive);
const raw = await readZipEntry(archive, entries[0], 1024 * 1024);
const root = parseXml(new TextDecoder().decode(raw), { maxNodes: 10_000 });
console.log(textContent(child(root, "title")!)); // "Jiange & Co."
```

## Subpath Exports

| Subpath | Contents |
| --- | --- |
| `@jiange/ooxml` | Re-exports `./zip` and `./xml` |
| `@jiange/ooxml/zip` | `createZip`, `createZipAsync`, `deflateRaw`, `inflateRaw`, `listZip`, `readZipEntry`, `crc32`, `ZipError`, `ZIP_DEFAULT_MAX_ENTRIES` |
| `@jiange/ooxml/xml` | `parseXml`, `child`, `children`, `textContent`, `escapeXml`, `XmlError`, `XmlElement`, `XmlNode` |

## Documentation

Full SDK documentation, benchmarks, and multi-language guides are available at [`https://github.com/ZSeven-W/jiange`](https://github.com/ZSeven-W/jiange) (see `sdk-docs/headless-sdks.md`).

## License

Free for personal and commercial use. If an enterprise modifies or creates derivative works from this SDK, it must publicly attribute Jiange SDK (`https://github.com/ZSeven-W/jiange`) as the source. See the bundled `LICENSE` file (repository root `LICENSE`) for full terms.
