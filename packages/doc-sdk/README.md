# @jiange/doc-sdk

AI-native headless block Document SDK (`v0.2.0`) over `@jiange/collab` and `@jiange/ooxml`: CRDT-backed `Document` Facade, Markdown / HTML / DOCX (DEFLATE) round-trip conversion, heading outline & section reading, mark-preserving `replaceText`, suggestions & comments, multi-column layouts, and self-describing AI tools.

Decoupled from `@jiange/whiteboard-sdk` (flowchart blocks serialize to Mermaid via a built-in zero-dependency converter or an optional `renderFlowchart` hook).

## Install

```bash
npm install @jiange/doc-sdk
```

- **Runtime dependencies**: `@jiange/collab`, `@jiange/ooxml` (0 third-party dependencies)
- **Bundle size**: ~58.1 KB gzip

## Features

- **High-Level `Document` Facade**: `Document.create`, `fromMarkdown`, `fromHtml`, `fromDocx`, `fromCollabDoc`, heading `outline()`, `readSection(headingOrId)`, `insertBlock`/`updateBlock`/`deleteBlock`/`moveBlock`, style-preserving `replaceText`, suggestions (`addSuggestion`, `acceptSuggestion`, `rejectSuggestion`), comments (`addComment`, `replyComment`, `resolveComment`), `undo()`/`redo()`, `inspect()`, `query()`, atomic `apply(ops, { dryRun })`, and `verify()`.
- **4-Way Format Conversion**: Normalized Markdown (`parseMarkdown`, `toMarkdown`), HTML (`parseHtml`, `blocksToHtml`), Plain Text (`toPlainText`), and bounded OOXML DOCX (`buildDocx`, `buildDocxAsync` DEFLATE, `parseDocx`, `docxExportLosses`) supporting H1–H9, tables & merges, embedded images, comments, footnotes, and headers/footers.
- **Self-Describing AI Toolkit (`createDocTools`)**: 7 JSON-Schema tools (`doc_inspect`, `doc_read_section`, `doc_query`, `doc_apply`, `doc_verify`, `doc_undo`, `doc_export_markdown`).
- **Low-Level CRDT Block & Table Operations**: `splitBlock`, `bodyBlocks`, table cell rich text, block styles, column width weights, and column move models.

## Quickstart

```ts
import { Document, createDocTools } from "@jiange/doc-sdk";

const doc = Document.fromMarkdown(
  "# Architecture Spec\n\n## Overview\n\nJiange Doc SDK runs headless on Node.js and browsers.\n",
  "Architecture Spec",
);

const tools = createDocTools(doc);
const outline = tools.execute("doc_inspect", { detail: "outline" });

// Propose a suggestion or apply atomic edits
const res = tools.execute("doc_apply", {
  ops: [
    { op: "replaceText", search: "headless", replacement: "AI-native headless" },
    { op: "addComment", blockId: doc.blocks()[2].id, body: "Verified for v0.2.0", author: "Reviewer" },
  ],
});

const docxBytes = await doc.toDocxAsync();
const md = doc.toMarkdown();
const html = doc.toHtml();
void [outline, res, docxBytes, md, html];
```

## Subpath Exports

| Subpath | Contents |
| --- | --- |
| `@jiange/doc-sdk` | Full barrel export (`Document`, `createDocTools`, Markdown, HTML, DOCX, CRDT block ops, column models) |
| `@jiange/doc-sdk/document` | `Document`, `DocOp`, `DocInspectResult`, `DocApplyResult`, `DocSuggestion`, `DocComment` |
| `@jiange/doc-sdk/ai-tools` | `createDocTools` |
| `@jiange/doc-sdk/markdown` | `parseMarkdown`, `toMarkdown`, `viewToMarkdown`, `parseInline`, `serializeInline` |
| `@jiange/doc-sdk/html` | `parseHtml`, `blocksToHtml` |
| `@jiange/doc-sdk/docx` | `buildDocx`, `buildDocxAsync`, `parseDocx`, `docxExportLosses`, `readDocxFile`, `safeDocxLink`, `imageInfo` |
| `@jiange/doc-sdk/model` | Low-level CRDT block ops (`splitBlock`, `bodyBlocks`, selection & formatting helpers) |
| `@jiange/doc-sdk/table-cells` / `./block-styles` / `./column-widths` / `./column-move` | Table cell rich-text model, block styles, column width weights, column move *(deprecated camelCase aliases: `./tableCells`, `./blockStyles`, `./columnWidths`, `./columnMove`)* |
| `@jiange/doc-sdk/zip` / `./xml` | Re-exports from `@jiange/ooxml` |
| `@jiange/doc-sdk/column-archive-experimental` | Unstable identity-preserving column archive helpers (`prepareColumnArchive`, `recoverColumnArchive`, `toggleArchivedColumn`) |

## Documentation

Full SDK documentation and recipes are available at [`https://github.com/ZSeven-W/jiange`](https://github.com/ZSeven-W/jiange) (see `sdk-docs/headless-sdks.md`).

## License

Free for personal and commercial use. If an enterprise modifies or creates derivative works from this SDK, it must publicly attribute Jiange SDK (`https://github.com/ZSeven-W/jiange`) as the source. See the bundled `LICENSE` file (repository root `LICENSE`) for full terms.
