import { afterEach, describe, expect, it, vi } from "vitest";
import type { Anchor } from "@jiange/collab";
import type { RemotePeer } from "./use-sync-doc";
import type { Presence } from "./presence";
import {
  createViewportBroadcaster,
  detectTopVisibleBlockId,
  findFollowBlockElement,
  findFollowPeer,
  hasActiveEditCursor,
  mergeViewportPresence,
  resolveFollowTargetBlock,
  shouldAutoExitFollow,
  VIEWPORT_BROADCAST_THROTTLE_MS,
} from "./follow-mode";

const sampleAnchor: Anchor = { char: { client: 1, clock: 3 }, side: 1 };

function makePeer(clientId: number, state: Presence): RemotePeer {
  return { clientId, state };
}

function makeMockBlock(
  attrs: Record<string, string>,
  rect: Partial<DOMRect>,
): HTMLElement {
  return {
    getAttribute: (name: string) => attrs[name] ?? null,
    getBoundingClientRect: () => ({
      x: rect.x ?? 0,
      y: rect.y ?? rect.top ?? 0,
      top: rect.top ?? 0,
      bottom: rect.bottom ?? (rect.top ?? 0) + (rect.height ?? 0),
      left: rect.left ?? 0,
      right: rect.right ?? (rect.left ?? 0) + (rect.width ?? 100),
      width: rect.width ?? 100,
      height: rect.height ?? Math.max(0, (rect.bottom ?? 0) - (rect.top ?? 0)),
      toJSON: () => ({}),
    }),
  } as unknown as HTMLElement;
}

function makeMockContainer(
  rect: Partial<DOMRect>,
  blocks: HTMLElement[],
  clientHeight = 600,
): HTMLElement {
  return {
    clientHeight,
    getBoundingClientRect: () => ({
      x: rect.x ?? 0,
      y: rect.y ?? rect.top ?? 0,
      top: rect.top ?? 0,
      bottom: rect.bottom ?? (rect.top ?? 0) + (rect.height ?? clientHeight),
      left: rect.left ?? 0,
      right: rect.right ?? 800,
      width: rect.width ?? 800,
      height: rect.height ?? clientHeight,
      toJSON: () => ({}),
    }),
    querySelectorAll: () => blocks,
    querySelector: (selector: string) => {
      const m = /^\[(data-block(?:-id)?)="(.+)"\]$/.exec(selector);
      if (!m) return null;
      const [, attr, rawVal] = m;
      const unescaped = rawVal.replace(/\\(.)/g, "$1");
      return blocks.find((b) => b.getAttribute(attr) === unescaped) ?? null;
    },
    contains: (el: Element | null) => blocks.includes(el as HTMLElement),
  } as unknown as HTMLElement;
}

describe("follow-mode helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("resolveFollowTargetBlock", () => {
    it("returns null for undefined peer or empty presence", () => {
      expect(resolveFollowTargetBlock(undefined)).toBeNull();
      expect(resolveFollowTargetBlock(makePeer(2, { name: "Alice", color: "#3370FF" }))).toBeNull();
      expect(resolveFollowTargetBlock(makePeer(2, { name: "Alice", color: "#3370FF", cursor: null }))).toBeNull();
      expect(resolveFollowTargetBlock(makePeer(2, { name: "Alice", color: "#3370FF", viewportBlock: "   " }))).toBeNull();
    });

    it("prioritizes active text cursor OpId over flow and viewportBlock", () => {
      const peer = makePeer(2, {
        name: "Alice",
        color: "#3370FF",
        cursor: { block: { client: 3, clock: 12 }, anchor: sampleAnchor },
        flow: { block: "3:99" },
        viewportBlock: "1:5",
      });
      expect(resolveFollowTargetBlock(peer)).toBe("3:12");
    });

    it("supports string block IDs on cursor for backward/external compatibility", () => {
      const peer = makePeer(2, {
        name: "Bob",
        color: "#F54A45",
        cursor: { block: "block-7" as unknown as { client: number; clock: number }, anchor: sampleAnchor },
        viewportBlock: "block-2",
      });
      expect(resolveFollowTargetBlock(peer)).toBe("block-7");
    });

    it("falls back to active flowchart block when cursor is null", () => {
      const peer = makePeer(3, {
        name: "Carol",
        color: "#00B42A",
        cursor: null,
        flow: { block: "2:8", x: 120, y: 80 },
        viewportBlock: "2:1",
      });
      expect(resolveFollowTargetBlock(peer)).toBe("2:8");
    });

    it("falls back to viewportBlock when peer is scrolling without an active cursor", () => {
      const peer = makePeer(4, {
        name: "Dave",
        color: "#FF8800",
        cursor: null,
        viewportBlock: "1:22",
      });
      expect(resolveFollowTargetBlock(peer)).toBe("1:22");
    });

    it("stays backward-compatible with peers that never send viewportBlock", () => {
      const legacyPeer = makePeer(5, {
        name: "Legacy",
        color: "#7F3BF5",
        cursor: { block: { client: 0, clock: 1 }, anchor: sampleAnchor },
      });
      expect(resolveFollowTargetBlock(legacyPeer)).toBe("0:1");
    });
  });

  describe("findFollowPeer", () => {
    const peers = [
      makePeer(10, { name: "Alice", color: "#3370FF" }),
      makePeer(20, { name: "Bob", color: "#F54A45", viewportBlock: "1:4" }),
    ];

    it("returns null when followingClientId is null or peer is absent", () => {
      expect(findFollowPeer(peers, null)).toBeNull();
      expect(findFollowPeer(peers, 999)).toBeNull();
      expect(findFollowPeer([], 10)).toBeNull();
    });

    it("finds the matching peer by clientId", () => {
      expect(findFollowPeer(peers, 20)).toBe(peers[1]);
    });
  });

  describe("shouldAutoExitFollow", () => {
    it("exits on Escape keydown, wheel, and touchmove", () => {
      expect(shouldAutoExitFollow({ type: "keydown", key: "Escape" })).toBe(true);
      expect(shouldAutoExitFollow({ type: "keydown", key: "Esc" })).toBe(true);
      expect(shouldAutoExitFollow({ type: "wheel" })).toBe(true);
      expect(shouldAutoExitFollow({ type: "touchmove" })).toBe(true);
    });

    it("does not exit on unrelated keys or programmatic scroll events", () => {
      expect(shouldAutoExitFollow({ type: "scroll" })).toBe(false);
      expect(shouldAutoExitFollow({ type: "keydown", key: "ArrowDown" })).toBe(false);
      expect(shouldAutoExitFollow({ type: "keydown", key: "Enter" })).toBe(false);
      expect(shouldAutoExitFollow({ type: "keyup", key: "Escape" })).toBe(false);
      expect(shouldAutoExitFollow({ type: "click" })).toBe(false);
      expect(shouldAutoExitFollow({ type: "mousemove" })).toBe(false);
    });
  });

  describe("detectTopVisibleBlockId", () => {
    it("returns null when container is null or has no blocks", () => {
      expect(detectTopVisibleBlockId(null)).toBeNull();
      expect(detectTopVisibleBlockId(makeMockContainer({ top: 56, bottom: 656 }, []))).toBeNull();
    });

    it("finds the topmost visible [data-block-id] element inside the viewport", () => {
      const blocks = [
        makeMockBlock({ "data-block-id": "0:1" }, { top: -140, bottom: -60 }),
        makeMockBlock({ "data-block-id": "1:1" }, { top: 20, bottom: 56 }), // bottom == viewTop, scrolled out
        makeMockBlock({ "data-block-id": "1:2" }, { top: 40, bottom: 110 }), // partially visible at top
        makeMockBlock({ "data-block-id": "1:3" }, { top: 120, bottom: 180 }),
        makeMockBlock({ "data-block-id": "1:4" }, { top: 700, bottom: 760 }), // below viewport
      ];
      const container = makeMockContainer({ top: 56, bottom: 656 }, blocks);
      expect(detectTopVisibleBlockId(container)).toBe("1:2");
    });

    it("also supports live editor [data-block] elements and ignores hidden zero-rect nodes", () => {
      const blocks = [
        makeMockBlock({ "data-block": "hidden" }, { top: 60, bottom: 60, width: 0, height: 0 }),
        makeMockBlock({ "data-block": "1:8" }, { top: 180, bottom: 240 }),
        makeMockBlock({ "data-block": "1:7" }, { top: 90, bottom: 160 }),
      ];
      const container = makeMockContainer({ top: 56, bottom: 656 }, blocks);
      expect(detectTopVisibleBlockId(container)).toBe("1:7");
    });

    it("returns null when all blocks are scrolled outside the viewport", () => {
      const blocks = [
        makeMockBlock({ "data-block-id": "1:1" }, { top: -200, bottom: -100 }),
        makeMockBlock({ "data-block-id": "1:2" }, { top: 800, bottom: 880 }),
      ];
      const container = makeMockContainer({ top: 56, bottom: 656 }, blocks);
      expect(detectTopVisibleBlockId(container)).toBeNull();
    });
  });

  describe("findFollowBlockElement", () => {
    it("locates elements by either data-block-id or data-block including keys with colons", () => {
      const b1 = makeMockBlock({ "data-block-id": "1:5" }, { top: 100, bottom: 140 });
      const b2 = makeMockBlock({ "data-block": "2:9" }, { top: 160, bottom: 200 });
      const container = makeMockContainer({ top: 0, bottom: 600 }, [b1, b2]);

      expect(findFollowBlockElement(container, "1:5")).toBe(b1);
      expect(findFollowBlockElement(container, "2:9")).toBe(b2);
      expect(findFollowBlockElement(container, "9:9")).toBeNull();
      expect(findFollowBlockElement(null, "1:5")).toBeNull();
    });
  });

  describe("hasActiveEditCursor", () => {
    it("detects focused editable elements inside the doc scroll container only", () => {
      const editable = { tagName: "DIV", isContentEditable: true } as unknown as HTMLElement;
      const textarea = { tagName: "TEXTAREA", isContentEditable: false } as unknown as HTMLElement;
      const readonlyDiv = { tagName: "DIV", isContentEditable: false, getAttribute: () => null } as unknown as HTMLElement;
      const outsideInput = { tagName: "INPUT", isContentEditable: false } as unknown as HTMLElement;
      const container = makeMockContainer({ top: 0, bottom: 600 }, [editable, textarea, readonlyDiv]);

      expect(hasActiveEditCursor(container, editable)).toBe(true);
      expect(hasActiveEditCursor(container, textarea)).toBe(true);
      expect(hasActiveEditCursor(container, readonlyDiv)).toBe(false);
      expect(hasActiveEditCursor(container, outsideInput)).toBe(false);
      expect(hasActiveEditCursor(null, editable)).toBe(false);
    });
  });

  describe("mergeViewportPresence", () => {
    it("preserves name, color, and existing presence fields when attaching viewportBlock", () => {
      const base: Presence = { name: "Alice", color: "#3370FF" };
      const existing: Partial<Presence> = {
        name: "Alice",
        color: "#3370FF",
        cursor: null,
        flow: { block: "1:9" },
      };
      expect(mergeViewportPresence(base, "1:12", existing)).toEqual({
        name: "Alice",
        color: "#3370FF",
        cursor: null,
        flow: { block: "1:9" },
        viewportBlock: "1:12",
      });
    });
  });

  describe("createViewportBroadcaster", () => {
    it("throttles rapid scroll updates and flushes the final settled block", () => {
      vi.useFakeTimers();
      const sent: string[] = [];
      const broadcaster = createViewportBroadcaster((id) => sent.push(id), VIEWPORT_BROADCAST_THROTTLE_MS);

      broadcaster.push("1:1");
      expect(sent).toEqual(["1:1"]);

      // Rapid scroll events within 300ms collapse to the latest block.
      vi.advanceTimersByTime(100);
      broadcaster.push("1:2");
      vi.advanceTimersByTime(100);
      broadcaster.push("1:3");
      expect(sent).toEqual(["1:1"]);

      vi.advanceTimersByTime(100);
      expect(sent).toEqual(["1:1", "1:3"]);

      // Identical block after cooldown is deduplicated.
      vi.advanceTimersByTime(300);
      broadcaster.push("1:3");
      expect(sent).toEqual(["1:1", "1:3"]);

      // Reset clears deduplication so re-entering scroll broadcasts again.
      broadcaster.reset();
      broadcaster.push("1:3");
      expect(sent).toEqual(["1:1", "1:3", "1:3"]);
    });
  });
});
