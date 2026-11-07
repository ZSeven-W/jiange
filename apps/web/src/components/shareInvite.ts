import type { ShareInfo, User } from "@/lib/api";

const emailKey = (email: string) => email.trim().toLowerCase();

/** Only suggest people who do not already have an explicit document role. */
export function inviteCandidates(query: string, users: User[], info: ShareInfo, ownerId: number): User[] {
  const needle = emailKey(query);
  if (!needle) return [];
  const shared = new Set(info.members.map((member) => emailKey(member.email)));
  return users.filter((user) => user.id !== ownerId && !shared.has(emailKey(user.email)) && `${user.name} ${user.email}`.toLowerCase().includes(needle)).slice(0, 8);
}

export function invitationConflict(email: string, info: ShareInfo, users: User[], ownerId: number): "owner" | "member" | null {
  const key = emailKey(email);
  if (users.some((user) => user.id === ownerId && emailKey(user.email) === key)) return "owner";
  return info.members.some((member) => emailKey(member.email) === key) ? "member" : null;
}
