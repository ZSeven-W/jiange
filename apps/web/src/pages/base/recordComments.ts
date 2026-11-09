import type { Comment, User } from "@/lib/api";

export interface Thread { root: Comment; replies: Comment[] }

/** Groups record comments into root threads (oldest first) with their replies. */
export function threadComments(comments: Comment[]): Thread[] {
  const byRoot = new Map<number, Comment[]>();
  for (const c of comments) if (c.parentId) byRoot.set(c.parentId, [...(byRoot.get(c.parentId) ?? []), c]);
  return comments.filter((c) => !c.parentId).map((root) => ({ root, replies: byRoot.get(root.id) ?? [] }));
}

/** Members whose 「@名字」 appears in body (the ids sent as mentions). */
export function mentionsIn(body: string, members: User[]): number[] {
  return members.filter((m) => m.name && body.includes("@" + m.name)).map((m) => m.id);
}

/** The @query being typed at the caret, or null. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const at = text.lastIndexOf("@", caret - 1);
  if (at < 0) return null;
  const query = text.slice(at + 1, caret);
  if (/[\s@]/.test(query) || query.length > 20) return null;
  return { start: at, query };
}

/** Splits body into text and mention chips for the given mentioned names. */
export function splitMentions(body: string, names: string[]): { text: string; mention: boolean }[] {
  const sorted = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
  const out: { text: string; mention: boolean }[] = [];
  let buf = "";
  for (let i = 0; i < body.length;) {
    const hit = body[i] === "@" ? sorted.find((n) => body.startsWith("@" + n, i)) : undefined;
    if (hit) {
      if (buf) out.push({ text: buf, mention: false });
      buf = "";
      out.push({ text: "@" + hit, mention: true });
      i += hit.length + 1;
    } else { buf += body[i]; i++; }
  }
  if (buf) out.push({ text: buf, mention: false });
  return out;
}
