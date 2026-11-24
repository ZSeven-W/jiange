import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Anchor } from "@jiange/collab";
import type { DocMeta, Me } from "@/lib/api";
import type { RemotePeer } from "@/lib/use-sync-doc";
import {
  createFollowScrollGuard,
  createViewportBroadcaster,
  findFollowPeer,
  FOLLOW_PROGRAMMATIC_SCROLL_MS,
  hasActiveEditCursor,
  mergeViewportPresence,
  resolveFollowTargetBlock,
  VIEWPORT_BROADCAST_THROTTLE_MS,
} from "@/lib/follow-mode";
import { t } from "@/lib/i18n";
import { FLOW_TEMPLATES } from "@/editor/flowchart/templates";
import { boardContentBounds, FlowchartBlock } from "@/editor/flowchart/flowchart-block";
import { edgePath, measureLabel, type FlowGraph } from "@/editor/flowchart/model";
import { docMetaKey } from "./doc-meta-state";

const mockSyncState = vi.hoisted(() => ({
  peers: [] as RemotePeer[],
  setAwareness: vi.fn(),
}));

vi.mock("@/lib/use-sync-doc", () => ({
  useSyncDoc: () => ({
    client: {
      doc: null,
      unacked: 0,
      status: "synced",
      blocked: null,
      setAwareness: mockSyncState.setAwareness,
      pendingOps: () => [],
    },
    version: 1,
    getChangeRevision: () => 0,
    peers: mockSyncState.peers,
    status: "synced",
    caughtUp: true,
    ready: true,
    blocked: null,
    storageError: false,
    legacyPending: false,
    otherPending: false,
    onBeforeRemote: () => () => {},
  }),
}));

vi.mock("@/editor/editor", () => ({
  Editor: () => <div data-testid="editor-body">正文内容</div>,
}));

vi.mock("@/components/collab-text", () => ({
  CollabText: () => <div>文档标题</div>,
}));

import { DocPage, FollowBanner, FollowPeerButton, FollowToast } from "./doc-page";

const me: Me = {
  user: { id: 1, email: "me@example.test", name: "我方用户", createdAt: "2026-01-01" },
  workspaces: [{ id: 1, name: "测试空间", ownerId: 1 }],
};

const docMeta: DocMeta = {
  id: 30,
  workspaceId: 1,
  parentId: null,
  title: "协同跟随测试文档",
  creatorId: 1,
  creatorName: "我方用户",
  icon: "",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  role: "edit",
  kind: "doc",
};

const anchor: Anchor = { char: { client: 2, clock: 4 }, side: 1 };

function renderDocPage(peers: RemotePeer[]) {
  mockSyncState.peers = peers;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  qc.setQueryData(docMetaKey(30, 1), docMeta);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <DocPage id={30} me={me} />
    </QueryClientProvider>,
  );
}

describe("Cloud Doc collaborative follow mode", () => {
  afterEach(() => {
    mockSyncState.peers = [];
    mockSyncState.setAwareness.mockReset();
    vi.useRealTimers();
  });

  it("renders interactive follow buttons for online peers in the DocPage header", () => {
    const peers: RemotePeer[] = [
      {
        clientId: 42,
        state: {
          name: "张三",
          color: "#F54A45",
          cursor: { block: { client: 2, clock: 5 }, anchor },
        },
      },
      {
        clientId: 43,
        state: {
          name: "李四",
          color: "#00B42A",
          cursor: null,
          viewportBlock: "1:9",
        },
      },
    ];

    const html = renderDocPage(peers);

    expect(html).toContain('data-follow-peer="42"');
    expect(html).toContain('data-follow-peer="43"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('title="点击跟随 张三 的视角"');
    expect(html).toContain('title="点击跟随 李四 的视角"');
    expect(html).not.toContain("data-follow-banner");
    expect(html).not.toContain("data-follow-toast");
    // Title wrapper exposes data-block="0:1" so peers editing the title can be followed.
    expect(html).toContain('data-block="0:1"');
  });

  it("renders active follow ring, live pulsing dot, and toggle tooltip on FollowPeerButton", () => {
    const peer: RemotePeer = {
      clientId: 77,
      state: { name: "王五", color: "#F54A45", viewportBlock: "1:4" },
    };

    const inactiveHtml = renderToStaticMarkup(<FollowPeerButton peer={peer} following={false} />);
    expect(inactiveHtml).toContain('data-follow-peer="77"');
    expect(inactiveHtml).toContain('aria-pressed="false"');
    expect(inactiveHtml).toContain('title="点击跟随 王五 的视角"');
    expect(inactiveHtml).not.toContain("data-follow-peer-live");

    const activeHtml = renderToStaticMarkup(<FollowPeerButton peer={peer} following={true} />);
    expect(activeHtml).toContain('data-follow-peer="77"');
    expect(activeHtml).toContain('aria-pressed="true"');
    expect(activeHtml).toContain('title="正在跟随 王五，点击退出"');
    expect(activeHtml).toContain("0 0 0 4px #F54A45");
    expect(activeHtml).toContain("data-follow-peer-live");
    expect(activeHtml).toContain("animate-ping");
  });

  it("renders Feishu-style floating FollowBanner and disconnect FollowToast", () => {
    const peer: RemotePeer = {
      clientId: 88,
      state: { name: "赵六", color: "#00B42A", viewportBlock: "1:12" },
    };

    const bannerHtml = renderToStaticMarkup(<FollowBanner peer={peer} onExit={() => {}} />);
    expect(bannerHtml).toContain("data-follow-banner");
    expect(bannerHtml).toContain("正在跟随 赵六 的视角");
    expect(bannerHtml).toContain("data-follow-exit");
    expect(bannerHtml).toContain("退出跟随");
    expect(bannerHtml).toContain("#00B42A");

    const toastHtml = renderToStaticMarkup(
      <FollowToast message={t("{name} 已离开文档，已退出跟随", { name: "赵六" })} />,
    );
    expect(toastHtml).toContain("data-follow-toast");
    expect(toastHtml).toContain('role="status"');
    expect(toastHtml).toContain("赵六 已离开文档，已退出跟随");
  });

  it("smoothly scrolls to followed peer blocks, suppresses programmatic scroll for 400ms, and auto-exits on manual scroll or Escape", () => {
    vi.useFakeTimers();
    const scrollIntoViewA = vi.fn();
    const scrollIntoViewB = vi.fn();
    const blockA = {
      getAttribute: (attr: string) => (attr === "data-block" ? "1:2" : null),
      scrollIntoView: scrollIntoViewA,
    } as unknown as HTMLElement;
    const blockB = {
      getAttribute: (attr: string) => (attr === "data-block-id" ? "1:8" : null),
      scrollIntoView: scrollIntoViewB,
    } as unknown as HTMLElement;
    const blocks = [blockA, blockB];
    const container = {
      querySelector: (selector: string) => {
        const m = /^\[(data-block(?:-id)?)="(.+)"\]$/.exec(selector);
        if (!m) return null;
        const [, attr, rawVal] = m;
        const val = rawVal.replace(/\\(.)/g, "$1");
        return blocks.find((b) => b.getAttribute(attr) === val) ?? null;
      },
    } as unknown as HTMLElement;

    const guard = createFollowScrollGuard(FOLLOW_PROGRAMMATIC_SCROLL_MS);
    const peer: RemotePeer = {
      clientId: 5,
      state: { name: "Alice", color: "#3370FF", cursor: { block: { client: 1, clock: 2 }, anchor } },
    };

    // Initial target resolves from cursor block and scrolls smoothly to center.
    const firstBlock = resolveFollowTargetBlock(peer)!;
    expect(firstBlock).toBe("1:2");
    expect(guard.scrollToBlock(container, peer.clientId, firstBlock)).toBe(true);
    expect(scrollIntoViewA).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(guard.isProgrammatic).toBe(true);

    // Repeating the same block does not redundantly re-scroll.
    expect(guard.scrollToBlock(container, peer.clientId, firstBlock)).toBe(false);
    expect(scrollIntoViewA).toHaveBeenCalledTimes(1);

    // During the 400ms suppression window, wheel/touchmove are ignored, while Escape exits immediately.
    expect(guard.shouldExitOnEvent({ type: "wheel" })).toBe(false);
    expect(guard.shouldExitOnEvent({ type: "touchmove" })).toBe(false);
    expect(guard.shouldExitOnEvent({ type: "keydown", key: "Escape" })).toBe(true);

    // After 400ms, programmatic flag clears and manual scroll gestures auto-exit follow mode.
    vi.advanceTimersByTime(FOLLOW_PROGRAMMATIC_SCROLL_MS);
    expect(guard.isProgrammatic).toBe(false);
    expect(guard.shouldExitOnEvent({ type: "wheel" })).toBe(true);
    expect(guard.shouldExitOnEvent({ type: "touchmove" })).toBe(true);

    // When peer scrolls without a cursor, target falls back to viewportBlock and scrolls smoothly.
    const scrolledPeer: RemotePeer = {
      clientId: 5,
      state: { name: "Alice", color: "#3370FF", cursor: null, viewportBlock: "1:8" },
    };
    const nextBlock = resolveFollowTargetBlock(scrolledPeer)!;
    expect(nextBlock).toBe("1:8");
    expect(guard.scrollToBlock(container, scrolledPeer.clientId, nextBlock)).toBe(true);
    expect(scrollIntoViewB).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });

    // Peer disconnecting leaves findFollowPeer returning null so DocPage exits cleanly.
    expect(findFollowPeer([], 5)).toBeNull();
    guard.dispose();
  });

  it("throttles viewportBlock presence broadcasts and skips when user has an active edit cursor", () => {
    vi.useFakeTimers();
    const sent: Array<ReturnType<typeof mergeViewportPresence>> = [];
    const base = { name: "我方用户", color: "#3370FF" };
    const existing = { name: "我方用户", color: "#3370FF", cursor: null };
    const broadcaster = createViewportBroadcaster((blockId) => {
      sent.push(mergeViewportPresence(base, blockId, existing));
    }, VIEWPORT_BROADCAST_THROTTLE_MS);

    const editable = { tagName: "DIV", isContentEditable: true } as unknown as HTMLElement;
    const container = { contains: (el: Element | null) => el === editable } as unknown as HTMLElement;

    // Active edit cursor inside doc container suppresses viewport broadcast.
    expect(hasActiveEditCursor(container, editable)).toBe(true);
    // Non-editing scroll broadcasts throttled viewportBlock preserving name/color/cursor.
    expect(hasActiveEditCursor(container, null)).toBe(false);

    broadcaster.push("1:1");
    broadcaster.push("1:2");
    broadcaster.push("1:3");
    expect(sent).toEqual([{ name: "我方用户", color: "#3370FF", cursor: null, viewportBlock: "1:1" }]);

    vi.advanceTimersByTime(VIEWPORT_BROADCAST_THROTTLE_MS);
    expect(sent).toEqual([
      { name: "我方用户", color: "#3370FF", cursor: null, viewportBlock: "1:1" },
      { name: "我方用户", color: "#3370FF", cursor: null, viewportBlock: "1:3" },
    ]);
    broadcaster.cancel();
  });
});

describe("Embedded whiteboard mobile narrow-screen preview bounds", () => {
  it("encloses the rightmost dashed '否' feedback loop and label inside boardContentBounds and viewBox", () => {
    const basic = FLOW_TEMPLATES.find((tpl) => tpl.id === "basic")!.build("feishu");
    const feedbackEdge = basic.edges.find((e) => e.label === "否")!;
    expect(feedbackEdge).toBeDefined();
    const fromNode = basic.nodes.find((n) => n.id === feedbackEdge.from)!;
    const toNode = basic.nodes.find((n) => n.id === feedbackEdge.to)!;
    const routed = edgePath(feedbackEdge, fromNode, toNode);
    const labelRight = routed.mid.x + Math.max(18, measureLabel(feedbackEdge.label!, 0) / 2);

    const b = boardContentBounds(basic);
    expect(b.x + b.w).toBeGreaterThanOrEqual(labelRight);
    expect(b.x + b.w).toBeGreaterThanOrEqual(feedbackEdge.mid!);

    const html = renderToStaticMarkup(
      <FlowchartBlock graph={basic} height={360} readOnly={true} />,
    );
    expect(html).toContain("w-full max-w-full overflow-hidden");
    expect(html).toContain('preserveAspectRatio="xMidYMid meet"');
    expect(html).toContain('width="100%"');
    expect(html).toContain('height="100%"');

    const vbMatch = /viewBox="([^"]+)"/.exec(html);
    expect(vbMatch).not.toBeNull();
    const [vx, , vw] = vbMatch![1].split(/\s+/).map(Number);
    expect(vx + vw).toBeGreaterThan(labelRight);
  });

  it("bounds curved edge control points, waypoints, and rotated nodes without clipping", () => {
    const graph: FlowGraph = {
      theme: "feishu",
      nodes: [
        { id: "a", shape: "rect", text: "A", x: 100, y: 100, w: 120, h: 60, rot: 45 },
        { id: "b", shape: "rect", text: "B", x: 100, y: 260, w: 120, h: 60 },
      ],
      edges: [
        {
          id: "e1",
          from: "a",
          to: "b",
          kind: "curve",
          fromPort: "right",
          toPort: "right",
          pts: [{ x: 340, y: 210 }],
          label: "重试回流分支",
        },
      ],
    };

    const b = boardContentBounds(graph);
    expect(b.x + b.w).toBeGreaterThanOrEqual(350);
    // Rotated 45deg 120x60 rect extends above y=100.
    expect(b.y).toBeLessThan(100);
  });
});
