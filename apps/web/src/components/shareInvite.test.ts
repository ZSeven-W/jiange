import { describe, expect, it } from "vitest";
import type { ShareInfo, User } from "@/lib/api";
import { invitationConflict, inviteCandidates } from "./shareInvite";

const info: ShareInfo = { role: "manage", link: { role: "none" }, members: [{ userId: 2, name: "已有成员", email: "member@example.com", role: "manage" }] };
const users: User[] = [
  { id: 1, name: "所有者", email: "owner@example.com", createdAt: "" },
  { id: 2, name: "已有成员", email: "MEMBER@example.com", createdAt: "" },
  { id: 3, name: "可邀请成员", email: "new@example.com", createdAt: "" },
];

describe("collaborator invitations", () => {
  it("does not suggest the owner or existing collaborators by name or email", () => {
    expect(inviteCandidates("example.com", users, info, 1).map((user) => user.id)).toEqual([3]);
    expect(inviteCandidates("已有", users, info, 1)).toEqual([]);
    expect(inviteCandidates("所有者", users, info, 1)).toEqual([]);
    expect(inviteCandidates("可邀请", users, info, 1).map((user) => user.id)).toEqual([3]);
  });
  it("rejects existing accounts from typed addresses regardless of case or whitespace", () => {
    expect(invitationConflict(" MEMBER@example.com ", info, users, 1)).toBe("member");
    expect(invitationConflict(" OWNER@example.com ", info, users, 1)).toBe("owner");
    expect(invitationConflict("new@example.com", info, users, 1)).toBeNull();
  });
});

it("requests create-only semantics for invitations while retaining permission updates", async () => {
  const { docsApi } = await import("@/lib/api");
  const requests: Array<{ method?: string; body?: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    requests.push({ method: init?.method, body: init?.body as string });
    return new Response(JSON.stringify(info), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    await docsApi.share(1, "new@example.com", "edit", true);
    await docsApi.share(1, "member@example.com", "view");
    expect(requests.map((request) => JSON.parse(request.body!))).toEqual([
      { email: "new@example.com", role: "edit", createOnly: true },
      { email: "member@example.com", role: "view" },
    ]);
    expect(requests.map((request) => request.method)).toEqual(["PUT", "PUT"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
