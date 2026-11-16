import type { DocView } from "@/lib/api";
import { isDocumentReferenceURL } from "@/lib/safe-url";

export interface MentionedPerson { userId: number; name: string; count: number; firstBlock: string; resolvedName: boolean }
export interface MentionSummary { people: MentionedPerson[]; truncated: boolean }
const MAX_SPANS = 50_000;
const MAX_PEOPLE = 500;
const TEXT_BLOCK = /^(paragraph|h[1-6]|bullet|ordered|todo|quote|callout)$/;
const BLOCK_ID = /^\d+:\d+$/;

/** Count visible contiguous mention runs in rendered text, not comments or hidden blocks. */
export function collectDocumentMentions(view: DocView, members: readonly { id: number; name: string }[] = []): MentionSummary {
  const names = new Map(members.filter((member) => Number.isSafeInteger(member.id) && member.id > 0 && member.name.trim()).map((member) => [member.id, member.name]));
  const people = new Map<number, MentionedPerson>();
  let scanned = 0, truncated = false;
  for (const block of view.blocks) {
    if (!TEXT_BLOCK.test(block.type) || !BLOCK_ID.test(block.id)) continue;
    const current = { id: 0, text: "" };
    const finish = () => {
      if (!current.id) return;
      const previous = people.get(current.id);
      if (previous) previous.count++;
      else if (people.size < MAX_PEOPLE) {
        const currentName = names.get(current.id);
        const label = [...current.text.replace(/^@/, "").replace(/[\p{Cc}\p{Cs}]/gu, "").trim()].slice(0, 80).join("");
        people.set(current.id, { userId: current.id, name: currentName || label || "", count: 1, firstBlock: block.id, resolvedName: !!currentName });
      } else truncated = true;
      current.id = 0; current.text = "";
    };
    for (const span of block.spans) {
      if (++scanned > MAX_SPANS) { truncated = true; break; }
      const raw = span.marks.mention;
      const id = raw && /^[1-9]\d*$/.test(raw) ? Number(raw) : 0;
      const valid = Number.isSafeInteger(id) && id > 0 && !!span.text && !span.marks.math && !isDocumentReferenceURL(span.marks.link);
      if (!valid) { finish(); continue; }
      if (current.id === id) current.text = (current.text + span.text.slice(0, 160)).slice(0, 160);
      else { finish(); current.id = id; current.text = span.text.slice(0, 160); }
    }
    finish();
    if (scanned > MAX_SPANS) break;
  }
  return { people: [...people.values()], truncated };
}
