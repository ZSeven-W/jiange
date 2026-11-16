import { describe, expect, it } from "vitest";
import type { AppNotification } from "./api";
import { mentionNotificationHash, parseMentionNotificationHash } from "./mention-notification-link";

const notice: AppNotification = { id: 1, userId: 2, docId: 7, actorId: 1, kind: "mention", read: false, createdAt: "", anchorBlock: "0:2", anchorChar: "3:9", anchorEpoch: 4 };
describe("document mention notification links", () => {
  it("round trips a scoped block, character and history epoch", () => {
    const hash = mentionNotificationHash(notice);
    expect(parseMentionNotificationHash(hash, 7)).toEqual({ block: "0:2", char: "3:9", epoch: 4 });
    expect(parseMentionNotificationHash(hash, 8)).toBeNull();
  });
  it("does not turn malformed, ambiguous or comment notifications into anchors", () => {
    expect(mentionNotificationHash({ ...notice, commentId: 3 })).toBe("#/doc/7");
    expect(mentionNotificationHash({ ...notice, anchorChar: "3:9007199254740992" })).toBe("#/doc/7");
    expect(parseMentionNotificationHash("#/doc/7?block=0%3A2&mention=3%3A9&mention=3%3A10&epoch=4", 7)).toBeNull();
    expect(parseMentionNotificationHash("#/doc/7?block=0%3A2&mention=3%3A9&epoch=0", 7)).toBeNull();
  });
});
