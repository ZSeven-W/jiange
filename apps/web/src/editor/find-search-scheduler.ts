import type { Doc } from "@jiange/collab";
import type { FindMatch } from "./find-replace";
import { findDocumentMatches } from "./table-find";

export interface FindSnapshot {
  doc: Doc;
  query: string;
  version: number;
  matches: FindMatch[];
}

/** Defer scanning so rapid query or collaborative updates can cancel stale work. */
export function scheduleFindSnapshot(doc: Doc, query: string, version: number, deliver: (snapshot: FindSnapshot) => void): () => void {
  const timer = setTimeout(() => deliver({ doc, query, version, matches: findDocumentMatches(doc, query) }), 150);
  return () => clearTimeout(timer);
}
