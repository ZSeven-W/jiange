import { Doc, Tx, encodeClientMsg, encodeOps, idKey } from "@jiange/collab";
import { replaceMatches, type FindMatch } from "./findReplace";

// A single client frame is limited to 8 MiB by syncsrv. More conservative
// work limits prevent a large synchronous transaction from freezing the UI.
export const FIND_FRAME_LIMIT = 8 << 20;
export const FIND_REPLACEMENT_BYTES_LIMIT = 1 << 20;
export const FIND_CHANGED_CODEPOINT_LIMIT = 20_000;
export const FIND_WORK_LIMIT = 200_000;
const FIND_STATE_BYTES_LIMIT = 16 << 20;

export type FindReplacePreflight =
  | { ok: true; frameBytes: number }
  | { ok: false; reason: "size" | "work" | "preflight" };

/**
 * Estimate synchronous work, then build and encode the exact operation batch
 * on an isolated replica. Nothing here mutates the caller's live document.
 * `frameLimit` may be lowered by a test, but cannot exceed the server limit.
 */
export function preflightFindReplace(doc: Doc, matches: readonly FindMatch[], replacement: string, frameLimit = FIND_FRAME_LIMIT): FindReplacePreflight {
  if (!matches.length) return { ok: true, frameBytes: 0 };
  const count = matches.length;
  // A UTF-16 code unit contributes at least one UTF-8 byte. Check this before
  // allocating a potentially enormous encoded copy or code-point array.
  if (replacement.length > FIND_REPLACEMENT_BYTES_LIMIT || replacement.length * count > FIND_REPLACEMENT_BYTES_LIMIT) return { ok: false, reason: "size" };
  const bytes = new TextEncoder().encode(replacement).length;
  if (bytes * count > FIND_REPLACEMENT_BYTES_LIMIT) return { ok: false, reason: "size" };
  const replacementPoints = [...replacement].length;
  let changedPoints = replacementPoints * count;
  let work = 0;
  const blockLengths = new Map<string, number>();
  for (const match of matches) {
    changedPoints += match.ids.length;
    if (changedPoints > FIND_CHANGED_CODEPOINT_LIMIT) return { ok: false, reason: "size" };
    const key = idKey(match.block);
    let length = blockLengths.get(key);
    if (length === undefined) {
      length = match.doc === doc && doc.hasBlock(match.block) ? doc.visibleIds(match.block).length : 0;
      blockLengths.set(key, length);
    }
    work += length;
    if (work > FIND_WORK_LIMIT) return { ok: false, reason: "work" };
  }
  try {
    const state = doc.encodeState();
    if (state.byteLength > FIND_STATE_BYTES_LIMIT) return { ok: false, reason: "work" };
    const copy = Doc.fromState(doc.client, state);
    // Preserve mismatched-document guards; only the original doc's matches
    // are rebound to the clone, while their character IDs remain unchanged.
    const copiedMatches = matches.map((match) => match.doc === doc ? { ...match, doc: copy } : match);
    const tx = new Tx(copy);
    replaceMatches(tx, copiedMatches, replacement);
    const frameBytes = tx.ops.length ? encodeClientMsg({ type: "ops", batch: encodeOps(tx.ops) }).byteLength : 0;
    if (frameBytes > Math.min(FIND_FRAME_LIMIT, frameLimit)) return { ok: false, reason: "size" };
    return { ok: true, frameBytes };
  } catch {
    return { ok: false, reason: "preflight" };
  }
}
