import type { SlideShape, SlidesPage } from "@/lib/api";
import type { ShapeAlignment } from "./slides-shape-order";
import { computeSlideShapeSnap, type SlideSnapGuide } from "./slides-snap";

export interface SlideRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Maps groupId -> ordered list of member shape IDs on a single slide page. */
export type SlideShapeGroups = Record<string, string[]>;

/** Maps pageId -> SlideShapeGroups for a deck. */
export type SlideDeckShapeGroups = Record<number, SlideShapeGroups>;

const DEFAULT_WIDTH = 16;
const DEFAULT_HEIGHT = 20;

const round1 = (value: number) => Math.round(value * 10) / 10;
const clampPct = (value: number, max: number) => round1(Math.min(max, Math.max(0, value)));
const shapeWidth = (shape: SlideShape) => shape.width ?? DEFAULT_WIDTH;
const shapeHeight = (shape: SlideShape) => shape.height ?? DEFAULT_HEIGHT;

export function normalizeSlideShapeGroups(
  raw: Record<string, unknown> | undefined,
): SlideShapeGroups | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const clean: SlideShapeGroups = {};
  for (const [groupId, members] of Object.entries(raw)) {
    if (!groupId || !Array.isArray(members)) continue;
    const unique = [...new Set(members.filter((item): item is string => typeof item === "string" && item.length > 0))];
    if (unique.length >= 2) clean[groupId] = unique;
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

/** Hydrate per-page shape groups directly from cloud-persisted page.meta. */
export function hydrateSlideShapeGroups(
  pages: readonly Pick<SlidesPage, "id" | "meta">[] | undefined,
): SlideDeckShapeGroups {
  if (!pages?.length) return {};
  const result: SlideDeckShapeGroups = {};
  for (const page of pages) {
    const clean = normalizeSlideShapeGroups(page.meta?.shapeGroups);
    if (clean) result[page.id] = clean;
  }
  return result;
}

export function sameSlideShapeGroups(
  a: SlideShapeGroups | undefined,
  b: SlideShapeGroups | undefined,
): boolean {
  const keysA = a ? Object.keys(a) : [];
  const keysB = b ? Object.keys(b) : [];
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    const listA = a![key];
    const listB = b?.[key];
    if (!listB || listA.length !== listB.length) return false;
    for (let i = 0; i < listA.length; i++) {
      if (listA[i] !== listB[i]) return false;
    }
  }
  return true;
}

export function slideShapeGroupsStorageKey(deckId: number): string {
  return `jiange:slides:shape-groups:${deckId}`;
}

export function loadSlideShapeGroups(deckId: number): SlideDeckShapeGroups {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(slideShapeGroupsStorageKey(deckId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: SlideDeckShapeGroups = {};
    for (const [pageKey, pageGroups] of Object.entries(parsed)) {
      const pageId = Number(pageKey);
      if (!Number.isSafeInteger(pageId) || pageId <= 0 || !pageGroups || typeof pageGroups !== "object" || Array.isArray(pageGroups)) {
        continue;
      }
      const cleanPage: SlideShapeGroups = {};
      for (const [groupId, members] of Object.entries(pageGroups as Record<string, unknown>)) {
        if (!groupId || !Array.isArray(members)) continue;
        const unique = [...new Set(members.filter((item): item is string => typeof item === "string" && item.length > 0))];
        if (unique.length >= 2) cleanPage[groupId] = unique;
      }
      if (Object.keys(cleanPage).length > 0) result[pageId] = cleanPage;
    }
    return result;
  } catch {
    return {};
  }
}

export function saveSlideShapeGroups(deckId: number, groups: SlideDeckShapeGroups): void {
  if (typeof localStorage === "undefined") return;
  try {
    const clean: SlideDeckShapeGroups = {};
    for (const [pageKey, pageGroups] of Object.entries(groups)) {
      const pageId = Number(pageKey);
      if (!Number.isSafeInteger(pageId) || pageId <= 0 || !pageGroups) continue;
      const cleanPage: SlideShapeGroups = {};
      for (const [groupId, members] of Object.entries(pageGroups)) {
        const unique = [...new Set(members.filter((item) => typeof item === "string" && item.length > 0))];
        if (unique.length >= 2) cleanPage[groupId] = unique;
      }
      if (Object.keys(cleanPage).length > 0) clean[pageId] = cleanPage;
    }
    localStorage.setItem(slideShapeGroupsStorageKey(deckId), JSON.stringify(clean));
  } catch {
    // Ignore storage quota errors
  }
}

/** Return IDs of all shapes intersecting a percentage-coordinate marquee rectangle. */
export function shapesInMarquee(shapes: readonly SlideShape[], rect: SlideRect): string[] {
  const minX = Math.min(rect.x, rect.x + rect.width);
  const maxX = Math.max(rect.x, rect.x + rect.width);
  const minY = Math.min(rect.y, rect.y + rect.height);
  const maxY = Math.max(rect.y, rect.y + rect.height);
  if (maxX <= minX || maxY <= minY) return [];
  const hits: string[] = [];
  for (const shape of shapes) {
    const sx = shape.x;
    const sy = shape.y;
    const sw = shapeWidth(shape);
    const sh = shapeHeight(shape);
    if (sx < maxX && sx + sw > minX && sy < maxY && sy + sh > minY) {
      hits.push(shape.id);
    }
  }
  return hits;
}

/** Compute the collective bounding box (in slide percentage units) for the given shape IDs. */
export function multiSelectionBounds(
  shapes: readonly SlideShape[],
  ids: readonly string[],
): SlideRect | null {
  if (!ids.length) return null;
  const idSet = new Set(ids);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let count = 0;
  for (const shape of shapes) {
    if (!idSet.has(shape.id)) continue;
    count++;
    const w = shapeWidth(shape);
    const h = shapeHeight(shape);
    if (shape.x < minX) minX = shape.x;
    if (shape.y < minY) minY = shape.y;
    if (shape.x + w > maxX) maxX = shape.x + w;
    if (shape.y + h > maxY) maxY = shape.y + h;
  }
  if (count === 0) return null;
  return {
    x: round1(minX),
    y: round1(minY),
    width: round1(maxX - minX),
    height: round1(maxY - minY),
  };
}

/** Evenly distribute 3+ selected shapes horizontally between the leftmost and rightmost shapes. */
export function distributeShapesHorizontally(
  shapes: readonly SlideShape[],
  ids: readonly string[],
): SlideShape[] {
  const idSet = new Set(ids);
  const selected = shapes
    .map((shape, index) => ({ shape, index }))
    .filter(({ shape }) => idSet.has(shape.id));
  if (selected.length < 3) return shapes.slice();

  selected.sort((a, b) => {
    const centerA = a.shape.x + shapeWidth(a.shape) / 2;
    const centerB = b.shape.x + shapeWidth(b.shape) / 2;
    return centerA - centerB || a.shape.x - b.shape.x || a.index - b.index;
  });

  const first = selected[0].shape;
  const last = selected[selected.length - 1].shape;
  const span = last.x + shapeWidth(last) - first.x;
  const totalWidth = selected.reduce((sum, item) => sum + shapeWidth(item.shape), 0);
  const gap = (span - totalWidth) / (selected.length - 1);

  const nextX = new Map<string, number>();
  let cursor = first.x + shapeWidth(first) + gap;
  for (let i = 1; i < selected.length - 1; i++) {
    const current = selected[i].shape;
    const w = shapeWidth(current);
    nextX.set(current.id, clampPct(cursor, Math.max(0, 100 - w)));
    cursor += w + gap;
  }

  return shapes.map((shape) => {
    const x = nextX.get(shape.id);
    if (x === undefined || x === shape.x) return shape;
    return { ...shape, x };
  });
}

/** Evenly distribute 3+ selected shapes vertically between the topmost and bottommost shapes. */
export function distributeShapesVertically(
  shapes: readonly SlideShape[],
  ids: readonly string[],
): SlideShape[] {
  const idSet = new Set(ids);
  const selected = shapes
    .map((shape, index) => ({ shape, index }))
    .filter(({ shape }) => idSet.has(shape.id));
  if (selected.length < 3) return shapes.slice();

  selected.sort((a, b) => {
    const centerA = a.shape.y + shapeHeight(a.shape) / 2;
    const centerB = b.shape.y + shapeHeight(b.shape) / 2;
    return centerA - centerB || a.shape.y - b.shape.y || a.index - b.index;
  });

  const first = selected[0].shape;
  const last = selected[selected.length - 1].shape;
  const span = last.y + shapeHeight(last) - first.y;
  const totalHeight = selected.reduce((sum, item) => sum + shapeHeight(item.shape), 0);
  const gap = (span - totalHeight) / (selected.length - 1);

  const nextY = new Map<string, number>();
  let cursor = first.y + shapeHeight(first) + gap;
  for (let i = 1; i < selected.length - 1; i++) {
    const current = selected[i].shape;
    const h = shapeHeight(current);
    nextY.set(current.id, clampPct(cursor, Math.max(0, 100 - h)));
    cursor += h + gap;
  }

  return shapes.map((shape) => {
    const y = nextY.get(shape.id);
    if (y === undefined || y === shape.y) return shape;
    return { ...shape, y };
  });
}

/** Align multiple selected shapes relative to their shared selection bounding box. */
export function alignMultipleShapes(
  shapes: readonly SlideShape[],
  ids: readonly string[],
  alignment: ShapeAlignment,
): SlideShape[] {
  const idSet = new Set(ids);
  const matchedCount = shapes.reduce((n, shape) => n + (idSet.has(shape.id) ? 1 : 0), 0);
  if (matchedCount < 2) return shapes.slice();
  const bounds = multiSelectionBounds(shapes, ids);
  if (!bounds) return shapes.slice();

  return shapes.map((shape) => {
    if (!idSet.has(shape.id)) return shape;
    const w = shapeWidth(shape);
    const h = shapeHeight(shape);
    let x = shape.x;
    let y = shape.y;
    if (alignment === "left") {
      x = clampPct(bounds.x, Math.max(0, 100 - w));
    } else if (alignment === "hcenter") {
      x = clampPct(bounds.x + (bounds.width - w) / 2, Math.max(0, 100 - w));
    } else if (alignment === "right") {
      x = clampPct(bounds.x + bounds.width - w, Math.max(0, 100 - w));
    } else if (alignment === "top") {
      y = clampPct(bounds.y, Math.max(0, 100 - h));
    } else if (alignment === "vcenter") {
      y = clampPct(bounds.y + (bounds.height - h) / 2, Math.max(0, 100 - h));
    } else {
      y = clampPct(bounds.y + bounds.height - h, Math.max(0, 100 - h));
    }
    return x === shape.x && y === shape.y ? shape : { ...shape, x, y };
  });
}

/** Rigidly translate a set of selected shapes together while keeping every shape inside [0, 100]. */
export function moveMultipleShapes(
  shapes: readonly SlideShape[],
  ids: readonly string[],
  dx: number,
  dy: number,
): SlideShape[] {
  const idSet = new Set(ids);
  const selected = shapes.filter((shape) => idSet.has(shape.id));
  if (!selected.length) return shapes.slice();

  let minDx = -Infinity;
  let maxDx = Infinity;
  let minDy = -Infinity;
  let maxDy = Infinity;
  for (const shape of selected) {
    minDx = Math.max(minDx, -shape.x);
    maxDx = Math.min(maxDx, Math.max(0, 100 - shapeWidth(shape)) - shape.x);
    minDy = Math.max(minDy, -shape.y);
    maxDy = Math.min(maxDy, Math.max(0, 100 - shapeHeight(shape)) - shape.y);
  }
  const clampedDx = Math.min(maxDx, Math.max(minDx, dx));
  const clampedDy = Math.min(maxDy, Math.max(minDy, dy));

  return shapes.map((shape) => {
    if (!idSet.has(shape.id)) return shape;
    const x = clampPct(shape.x + clampedDx, Math.max(0, 100 - shapeWidth(shape)));
    const y = clampPct(shape.y + clampedDy, Math.max(0, 100 - shapeHeight(shape)));
    return x === shape.x && y === shape.y ? shape : { ...shape, x, y };
  });
}

/** Drag multiple/grouped shapes together with smart Feishu snapping on their collective bounds. */
export function snapMultipleShapes(
  shapes: readonly SlideShape[],
  ids: readonly string[],
  dx: number,
  dy: number,
  threshold = 1.2,
): { shapes: SlideShape[]; guides: SlideSnapGuide[] } {
  const idSet = new Set(ids);
  const rawMoved = moveMultipleShapes(shapes, ids, dx, dy);
  const bounds = multiSelectionBounds(rawMoved, ids);
  if (!bounds) return { shapes: rawMoved, guides: [] };

  const siblings = rawMoved.filter((shape) => !idSet.has(shape.id));
  const virtualBox: SlideShape = {
    id: "__multi_selection_bounds__",
    kind: "rectangle",
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    color: "#3370ff",
  };
  const snapped = computeSlideShapeSnap(virtualBox, siblings, threshold);
  const snapDx = snapped.shape.x - bounds.x;
  const snapDy = snapped.shape.y - bounds.y;
  if (snapDx === 0 && snapDy === 0) {
    return { shapes: rawMoved, guides: snapped.guides };
  }
  return {
    shapes: moveMultipleShapes(rawMoved, ids, snapDx, snapDy),
    guides: snapped.guides,
  };
}

export function findShapeGroup(
  pageGroups: SlideShapeGroups | undefined,
  shapeId: string,
): { groupId: string; memberIds: string[] } | null {
  if (!pageGroups) return null;
  for (const [groupId, members] of Object.entries(pageGroups)) {
    if (members.includes(shapeId)) {
      return { groupId, memberIds: members };
    }
  }
  return null;
}

/** Expand any selected shape IDs to include all sibling members of their persisted groups. */
export function expandSelectionWithGroups(
  selectedIds: readonly string[],
  pageGroups: SlideShapeGroups | undefined,
  existingShapeIds?: ReadonlySet<string>,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const addId = (id: string) => {
    if (seen.has(id)) return;
    if (existingShapeIds && !existingShapeIds.has(id)) return;
    seen.add(id);
    result.push(id);
  };
  for (const id of selectedIds) {
    const group = findShapeGroup(pageGroups, id);
    if (group) {
      for (const memberId of group.memberIds) addId(memberId);
    } else {
      addId(id);
    }
  }
  return result;
}

/** Compute next shape selection for plain click or Shift+Click, honoring shape groups. */
export function toggleShapeSelection(
  currentSelected: readonly string[],
  clickedId: string,
  shiftKey: boolean,
  pageGroups: SlideShapeGroups | undefined,
  existingShapeIds?: ReadonlySet<string>,
): string[] {
  const clickedUnit = expandSelectionWithGroups([clickedId], pageGroups, existingShapeIds);
  if (!shiftKey) return clickedUnit;
  const currentSet = new Set(currentSelected);
  const allAlreadySelected = clickedUnit.length > 0 && clickedUnit.every((id) => currentSet.has(id));
  if (allAlreadySelected) {
    const removeSet = new Set(clickedUnit);
    return currentSelected.filter((id) => !removeSet.has(id));
  }
  return expandSelectionWithGroups([...currentSelected, ...clickedUnit], pageGroups, existingShapeIds);
}

/** True when the current selection corresponds cleanly to a single persisted shape group. */
export function isSelectionSingleGroup(
  pageGroups: SlideShapeGroups | undefined,
  selectedIds: readonly string[],
): boolean {
  if (!pageGroups || selectedIds.length < 2) return false;
  const firstGroup = findShapeGroup(pageGroups, selectedIds[0]);
  if (!firstGroup) return false;
  const selectedSet = new Set(selectedIds);
  if (selectedSet.size !== firstGroup.memberIds.length) return false;
  return firstGroup.memberIds.every((memberId) => selectedSet.has(memberId));
}

/** Group 2+ selected shapes, removing them from any prior groups first. */
export function groupShapes(
  pageGroups: SlideShapeGroups | undefined,
  selectedIds: readonly string[],
  groupId?: string,
): SlideShapeGroups {
  const unique = [...new Set(selectedIds.filter(Boolean))];
  if (unique.length < 2) return pageGroups ? { ...pageGroups } : {};
  const memberSet = new Set(unique);
  const next: SlideShapeGroups = {};
  if (pageGroups) {
    for (const [id, members] of Object.entries(pageGroups)) {
      const remaining = members.filter((memberId) => !memberSet.has(memberId));
      if (remaining.length >= 2) next[id] = remaining;
    }
  }
  const newId = groupId ?? `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  next[newId] = unique;
  return next;
}

/** Ungroup any group containing one or more of the selected shapes. */
export function ungroupShapes(
  pageGroups: SlideShapeGroups | undefined,
  selectedIds: readonly string[],
): SlideShapeGroups {
  if (!pageGroups || !selectedIds.length) return pageGroups ? { ...pageGroups } : {};
  const selectedSet = new Set(selectedIds);
  const next: SlideShapeGroups = {};
  for (const [groupId, members] of Object.entries(pageGroups)) {
    if (!members.some((memberId) => selectedSet.has(memberId))) {
      next[groupId] = members;
    }
  }
  return next;
}

/** Drop deleted shape IDs from groups and remove any group that falls below 2 members. */
export function pruneShapeGroups(
  pageGroups: SlideShapeGroups | undefined,
  existingShapeIds: ReadonlySet<string>,
): SlideShapeGroups {
  if (!pageGroups) return {};
  const next: SlideShapeGroups = {};
  for (const [groupId, members] of Object.entries(pageGroups)) {
    const remaining = members.filter((id) => existingShapeIds.has(id));
    if (remaining.length >= 2) next[groupId] = remaining;
  }
  return next;
}
