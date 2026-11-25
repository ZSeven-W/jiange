import { idKey, type OpId } from "@zseven-w/collab";
import type { Presence } from "./presence";
import type { RemotePeer } from "./use-sync-doc";

/** Suppression window after smooth programmatic scroll so it does not auto-exit follow mode. */
export const FOLLOW_PROGRAMMATIC_SCROLL_MS = 400;

/** Throttle interval for broadcasting the local user's top visible block while scrolling. */
export const VIEWPORT_BROADCAST_THROTTLE_MS = 300;

function normalizeBlockKey(block: OpId | string | null | undefined): string | null {
  if (!block) return null;
  if (typeof block === "string") {
    const trimmed = block.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (
    typeof block === "object" &&
    typeof block.client === "number" &&
    Number.isFinite(block.client) &&
    typeof block.clock === "number" &&
    Number.isFinite(block.clock)
  ) {
    return idKey(block);
  }
  return null;
}

/**
 * Resolves the best target block key to scroll to for a followed collaborator.
 * Prioritizes active text cursor/selection block, then active embedded flowchart block,
 * and falls back to the peer's reading viewport block (`viewportBlock`).
 */
export function resolveFollowTargetBlock(peer: RemotePeer | undefined): string | null {
  const state = peer?.state;
  if (!state || typeof state !== "object") return null;

  const cursorBlock = normalizeBlockKey(state.cursor?.block as OpId | string | null | undefined);
  if (cursorBlock) return cursorBlock;

  const flowBlock = normalizeBlockKey(state.flow?.block);
  if (flowBlock) return flowBlock;

  return normalizeBlockKey(state.viewportBlock);
}

/** Finds the currently followed collaborator in the active peers list. */
export function findFollowPeer(peers: readonly RemotePeer[], followingClientId: number | null): RemotePeer | null {
  if (followingClientId === null) return null;
  return peers.find((peer) => peer.clientId === followingClientId) ?? null;
}

/**
 * Determines whether a user interaction event should automatically exit follow mode.
 * Exits on Escape keypress or manual scroll gestures (`wheel` / `touchmove`).
 */
export function shouldAutoExitFollow(event: { type: string; key?: string }): boolean {
  if (event.type === "wheel" || event.type === "touchmove") return true;
  if (event.type === "keydown" && (event.key === "Escape" || event.key === "Esc")) return true;
  return false;
}

function readBlockId(el: Element): string | null {
  const raw = el.getAttribute("data-block-id") ?? el.getAttribute("data-block");
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Finds the topmost visible block element (`[data-block-id]` or `[data-block]`) inside the
 * scrolling document container so reading scroll position can be broadcast as `viewportBlock`.
 */
export function detectTopVisibleBlockId(container: HTMLElement | null): string | null {
  if (!container) return null;
  const nodes = container.querySelectorAll<HTMLElement>("[data-block-id], [data-block]");
  if (!nodes.length) return null;

  const containerRect = container.getBoundingClientRect();
  const viewTop = containerRect.top;
  const viewBottom =
    containerRect.bottom > containerRect.top
      ? containerRect.bottom
      : viewTop + (container.clientHeight > 0 ? container.clientHeight : Number.POSITIVE_INFINITY);

  let bestId: string | null = null;
  let bestTop = Number.POSITIVE_INFINITY;

  for (const el of nodes) {
    const id = readBlockId(el);
    if (!id) continue;
    const rect = el.getBoundingClientRect();
    // Skip hidden / unlaid-out elements with zero geometry.
    if (rect.bottom <= rect.top && rect.width === 0 && rect.height === 0) continue;
    // Must intersect the visible vertical range of the scroll container.
    if (rect.bottom <= viewTop || rect.top >= viewBottom) continue;
    if (rect.top < bestTop) {
      bestTop = rect.top;
      bestId = id;
    }
  }

  return bestId;
}

/** Escapes a block key safely for CSS attribute selector lookups. */
function escapeAttrValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

/** Locates the DOM element corresponding to a block key inside a document scroll container. */
export function findFollowBlockElement(container: HTMLElement | null, blockId: string): HTMLElement | null {
  if (!container || !blockId) return null;
  const escaped = escapeAttrValue(blockId);
  return (
    container.querySelector<HTMLElement>(`[data-block-id="${escaped}"]`) ??
    container.querySelector<HTMLElement>(`[data-block="${escaped}"]`)
  );
}

/**
 * Returns true when the local user currently has keyboard focus inside an editable
 * document surface (text editor, title textarea, or form input inside the scroll container).
 */
export function hasActiveEditCursor(
  container: HTMLElement | null,
  activeElement: Element | null = typeof document !== "undefined" ? document.activeElement : null,
): boolean {
  if (!container || !activeElement) return false;
  if (!container.contains(activeElement)) return false;
  const tag = activeElement.tagName?.toUpperCase();
  if (tag === "TEXTAREA" || tag === "INPUT") return true;
  const htmlEl = activeElement as HTMLElement;
  if (htmlEl.isContentEditable) return true;
  const attr = activeElement.getAttribute?.("contenteditable");
  return attr === "" || attr === "true" || attr === "plaintext-only";
}

/**
 * Merges `viewportBlock` into presence state without stripping existing identity or presence fields.
 */
export function mergeViewportPresence(
  base: Presence,
  viewportBlock: string,
  existing?: Partial<Presence> | null,
): Presence {
  return {
    ...(existing ?? {}),
    ...base,
    viewportBlock,
  };
}

export interface ViewportBroadcaster {
  push: (blockId: string | null) => void;
  reset: () => void;
  cancel: () => void;
}

/**
 * Throttles `viewportBlock` awareness broadcasts (leading + trailing) and deduplicates repeats.
 */
export function createViewportBroadcaster(
  send: (blockId: string) => void,
  intervalMs = VIEWPORT_BROADCAST_THROTTLE_MS,
): ViewportBroadcaster {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSent: string | null = null;
  let pending: string | null = null;
  let coolingDown = false;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const emit = (blockId: string) => {
    lastSent = blockId;
    coolingDown = true;
    send(blockId);
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      coolingDown = false;
      const queued = pending;
      pending = null;
      if (queued && queued !== lastSent) {
        emit(queued);
      }
    }, intervalMs);
  };

  return {
    push(blockId: string | null) {
      if (!blockId) return;
      if (!coolingDown) {
        if (blockId !== lastSent) emit(blockId);
      } else {
        pending = blockId;
      }
    },
    reset() {
      clearTimer();
      coolingDown = false;
      lastSent = null;
      pending = null;
    },
    cancel() {
      clearTimer();
      coolingDown = false;
      pending = null;
    },
  };
}

export interface FollowScrollGuard {
  readonly isProgrammatic: boolean;
  scrollToBlock: (container: HTMLElement | null, clientId: number, blockId: string) => boolean;
  shouldExitOnEvent: (event: { type: string; key?: string }) => boolean;
  reset: () => void;
  dispose: () => void;
}

/**
 * Coordinates smooth scroll-into-view for a followed peer's active block while suppressing
 * manual-scroll auto-exit during the smooth scroll animation window (~400ms).
 */
export function createFollowScrollGuard(
  suppressionMs = FOLLOW_PROGRAMMATIC_SCROLL_MS,
): FollowScrollGuard {
  let programmatic = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastTarget: { clientId: number; blockId: string } | null = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    get isProgrammatic() {
      return programmatic;
    },
    scrollToBlock(container, clientId, blockId) {
      if (lastTarget?.clientId === clientId && lastTarget.blockId === blockId) return false;
      const el = findFollowBlockElement(container, blockId);
      if (!el) return false;
      lastTarget = { clientId, blockId };
      programmatic = true;
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        programmatic = false;
      }, suppressionMs);
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      return true;
    },
    shouldExitOnEvent(event) {
      if (event.type === "keydown") return shouldAutoExitFollow(event);
      if (programmatic) return false;
      return shouldAutoExitFollow(event);
    },
    reset() {
      lastTarget = null;
    },
    dispose() {
      clearTimer();
      programmatic = false;
      lastTarget = null;
    },
  };
}
