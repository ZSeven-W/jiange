import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemberCard } from "./MemberCard";

describe("@member hover card", () => {
  it("shows avatar, name, email, role and actions", () => {
    const html = renderToStaticMarkup(<MemberCard member={{ id: 2, name: "Alice", email: "alice@jiange.dev", role: "协作者" }} fallbackName="Alice" x={0} y={0} onCopyEmail={() => {}} />);
    expect(html).toContain('data-member-card="2"');
    expect(html).toContain("Alice");
    expect(html).toContain("alice@jiange.dev");
    expect(html).toContain("协作者");
    expect(html).toContain('href="mailto:alice@jiange.dev"');
    expect(html).toContain("data-member-copy");
  });
  it("hides copy when copying is restricted and marks the current user", () => {
    const html = renderToStaticMarkup(<MemberCard member={{ id: 1, name: "Kay", email: "kay@jiange.dev" }} fallbackName="Kay" x={0} y={0} isMe />);
    expect(html).not.toContain("data-member-copy");
    expect(html).toContain(">我<");
  });
  it("falls back to the mentioned name when member details are unavailable", () => {
    const html = renderToStaticMarkup(<MemberCard fallbackName="Bob" x={0} y={0} />);
    expect(html).toContain("Bob");
    expect(html).toContain("暂无成员信息");
    expect(html).not.toContain("mailto:");
  });
});
