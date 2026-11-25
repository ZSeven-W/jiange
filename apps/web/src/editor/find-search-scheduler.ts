import type { Doc } from "@zseven-w/collab";
import type { FindMatch, FindOptions } from "./find-replace";
import { findDocumentMatches } from "./table-find";

export interface FindSnapshot {
  doc: Doc;
  query: string;
  version: number;
  caseSensitive?: boolean;
  includeMath?: boolean;
  matches: FindMatch[];
}

/** Defer scanning so rapid query or collaborative updates can cancel stale work. */
export function scheduleFindSnapshot(
  doc: Doc,
  query: string,
  version: number,
  deliver: (snapshot: FindSnapshot) => void,
  options: FindOptions = {},
): () => void {
  const caseSensitive = !!options.caseSensitive;
  const includeMath = !!options.includeMath;
  const timer = setTimeout(
    () => deliver({ doc, query, version, caseSensitive, includeMath, matches: findDocumentMatches(doc, query, { caseSensitive, includeMath }) }),
    150,
  );
  return () => clearTimeout(timer);
}
