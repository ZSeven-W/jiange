import type { Doc } from "@jiange/collab";
import { findMatches, type FindMatch } from "./findReplace";

export interface FindSnapshot {
  doc: Doc;
  query: string;
  version: number;
  matches: FindMatch[];
}

/** Defer scanning so rapid query or collaborative updates can cancel stale work. */
export function scheduleFindSnapshot(doc: Doc, query: string, version: number, deliver: (snapshot: FindSnapshot) => void): () => void {
  const timer = setTimeout(() => deliver({ doc, query, version, matches: findMatches(doc, query) }), 150);
  return () => clearTimeout(timer);
}
