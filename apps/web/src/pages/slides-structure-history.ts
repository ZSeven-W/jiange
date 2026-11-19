import type { ImportedSlidePage, SlidesPage } from "@/lib/api";

export type SlideStructureAction =
  | {
      kind: "delete";
      seq: number;
      pageId: number;
      index: number;
      snapshot: ImportedSlidePage;
    }
  | {
      kind: "insert";
      seq: number;
      pageId: number;
      index: number;
      snapshot: ImportedSlidePage;
    }
  | {
      kind: "reorder";
      seq: number;
      pageId: number;
      fromIndex: number;
      toIndex: number;
    }
  | {
      kind: "visibility";
      seq: number;
      pageId: number;
      beforeHidden: boolean;
      afterHidden: boolean;
    };

export interface SlideStructureHistory {
  undo: SlideStructureAction[];
  redo: SlideStructureAction[];
}

export const SLIDE_STRUCTURE_HISTORY_LIMIT = 50;

export function emptyStructureHistory(): SlideStructureHistory {
  return { undo: [], redo: [] };
}

export function snapshotSlidePage(page: Pick<SlidesPage, "title" | "body" | "background" | "layout" | "notes" | "hidden" | "shapes">): ImportedSlidePage {
  return {
    title: page.title,
    body: page.body,
    background: page.background,
    layout: page.layout ?? "",
    notes: page.notes,
    hidden: page.hidden,
    shapes: page.shapes.map((s) => ({ ...s })),
  };
}

export function pushStructureAction(
  history: SlideStructureHistory,
  action: SlideStructureAction,
): SlideStructureHistory {
  return {
    undo: [...history.undo, action].slice(-SLIDE_STRUCTURE_HISTORY_LIMIT),
    redo: [],
  };
}

export function popStructureAction(
  history: SlideStructureHistory,
  redo: boolean,
): { action: SlideStructureAction; next: SlideStructureHistory } | null {
  const source = redo ? history.redo : history.undo;
  const action = source.at(-1);
  if (!action) return null;
  if (redo) {
    return {
      action,
      next: { undo: history.undo, redo: source.slice(0, -1) },
    };
  }
  return {
    action,
    next: { undo: source.slice(0, -1), redo: history.redo },
  };
}

export function commitStructureTravel(
  history: SlideStructureHistory,
  redo: boolean,
  original: SlideStructureAction,
  transformed: SlideStructureAction,
): SlideStructureHistory {
  const fromKey = redo ? "redo" : "undo";
  const toKey = redo ? "undo" : "redo";
  const from = history[fromKey];
  if (from.at(-1) !== original) return history;
  return {
    ...history,
    [fromKey]: from.slice(0, -1),
    [toKey]: [...history[toKey], transformed].slice(-SLIDE_STRUCTURE_HISTORY_LIMIT),
  } as SlideStructureHistory;
}

export function structureActionLabel(action: SlideStructureAction | undefined, redo: boolean): string {
  if (!action) return redo ? "重做" : "撤销";
  const verb = redo ? "重做" : "撤销";
  switch (action.kind) {
    case "delete":
      return `${verb}删除页面`;
    case "insert":
      return `${verb}新建页面`;
    case "reorder":
      return `${verb}页面排序`;
    case "visibility":
      return `${verb}隐藏状态`;
  }
}
