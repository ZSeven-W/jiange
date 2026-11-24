import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { driveApi, type DocMeta, type DriveEntry, type Workspace } from "@/lib/api";
import { crossSpaceMoveApi } from "@/lib/cross-space-move-api";
import {
  DocumentMoveDialog,
  executeDocumentMove,
  isCrossSpaceMove,
  type MoveSource,
} from "./document-move-dialog";

const sampleDoc: DocMeta = {
  id: 7,
  workspaceId: 3,
  parentId: null,
  title: "架构方案",
  icon: "",
  creatorId: 1,
  creatorName: "Alice",
  createdAt: "2026-11-24T00:00:00Z",
  updatedAt: "2026-11-24T00:00:00Z",
  role: "manage",
  kind: "doc",
  driveRevision: 4,
};

const workspaces: Workspace[] = [
  { id: 3, name: "研发工作空间", ownerId: 1 },
  { id: 8, name: "产品设计空间", ownerId: 2 },
];

const personalSource: MoveSource = {
  meta: sampleDoc,
  personal: true,
  workspaces,
};

const sharedFolder: DriveEntry = {
  id: 30,
  workspaceId: 3,
  parentId: null,
  title: "团队文档库",
  kind: "folder",
  role: "manage",
  revision: 1,
  personal: false,
  updatedAt: "2026-11-24T00:00:00Z",
};

describe("DocumentMoveDialog cross-space move", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("unlocks both personal & shared scopes, renders FeishuSelect workspace picker, and has zero native selects", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["document-move-source", 1, 7], personalSource);
    qc.setQueryData(["document-move-folders", 1, 7, 3, true, null], []);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <DocumentMoveDialog
          docId={7}
          userId={1}
          workspaces={workspaces}
          inlineForTest={true}
          onClose={() => {}}
          onMoved={() => {}}
        />
      </QueryClientProvider>,
    );

    expect(html).toContain("data-move-workspace-select");
    expect(html).toContain('role="combobox"');
    expect(html).toContain("研发工作空间");
    expect(html).toContain("产品设计空间");
    expect(html).toContain('data-move-scope-btn="personal"');
    expect(html).toContain('data-move-scope-btn="shared"');
    expect(html).not.toContain("暂不支持跨空间移动");
    expect(html).not.toContain("data-cross-space-move-banner");
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("shows the amber confirmation banner when moving from personal to shared scope", () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    qc.setQueryData(["document-move-source", 1, 7], personalSource);
    qc.setQueryData(["document-move-folders", 1, 7, 3, false, null], [sharedFolder]);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <DocumentMoveDialog
          docId={7}
          userId={1}
          workspaces={workspaces}
          initialTargetPersonal={false}
          inlineForTest={true}
          onClose={() => {}}
          onMoved={() => {}}
        />
      </QueryClientProvider>,
    );

    expect(html).toContain("data-cross-space-move-banner");
    expect(html).toContain("跨空间移动将同步更新该条目及子目录的所属空间与可见范围");
    expect(html).toContain("团队文档库");
    // Confirm button should be enabled even at root because scope changed.
    expect(html).toContain('data-move-confirm-btn="true"');
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*data-move-confirm-btn/i);
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("shows the amber confirmation banner when switching to another workspace", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["document-move-source", 1, 7], personalSource);
    qc.setQueryData(["document-move-folders", 1, 7, 8, true, null], []);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <DocumentMoveDialog
          docId={7}
          userId={1}
          workspaces={workspaces}
          initialTargetWorkspaceId={8}
          initialTargetPersonal={true}
          inlineForTest={true}
          onClose={() => {}}
          onMoved={() => {}}
        />
      </QueryClientProvider>,
    );

    expect(html).toContain("data-cross-space-move-banner");
    expect(html).toContain("跨空间移动将同步更新该条目及子目录的所属空间与可见范围");
    expect(html).toContain("产品设计空间 / 我的文件夹");
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("detects cross-space vs same-scope moves accurately", () => {
    expect(isCrossSpaceMove(personalSource, 3, true)).toBe(false);
    expect(isCrossSpaceMove(personalSource, 3, false)).toBe(true);
    expect(isCrossSpaceMove(personalSource, 8, true)).toBe(true);
    expect(isCrossSpaceMove(personalSource, 8, false)).toBe(true);
  });

  it("keeps same-scope moves on driveApi.moveForAccount and routes cross-space moves to crossSpaceMoveApi.move", async () => {
    const sameSpy = vi.spyOn(driveApi, "moveForAccount").mockResolvedValue(undefined);
    const crossSpy = vi.spyOn(crossSpaceMoveApi, "move").mockResolvedValue(sharedFolder);

    // 1. Same workspace + same personal scope -> existing driveApi.moveForAccount.
    await executeDocumentMove({
      docId: 7,
      userId: 1,
      source: personalSource,
      targetWorkspaceId: 3,
      targetParentId: 99,
      targetPersonal: true,
    });
    expect(sameSpy).toHaveBeenCalledTimes(1);
    expect(sameSpy).toHaveBeenCalledWith(7, 99, 4, 1);
    expect(crossSpy).not.toHaveBeenCalled();

    // 2. Cross personal/shared scope in same workspace -> crossSpaceMoveApi.move.
    await executeDocumentMove({
      docId: 7,
      userId: 1,
      source: personalSource,
      targetWorkspaceId: 3,
      targetParentId: 30,
      targetPersonal: false,
    });
    expect(crossSpy).toHaveBeenCalledTimes(1);
    expect(crossSpy).toHaveBeenCalledWith({
      nodeId: 7,
      targetWorkspaceId: 3,
      targetParentId: 30,
      targetPersonal: false,
      expected: 4,
      userId: 1,
    });

    // 3. Cross workspace -> crossSpaceMoveApi.move.
    await executeDocumentMove({
      docId: 7,
      userId: 1,
      source: personalSource,
      targetWorkspaceId: 8,
      targetParentId: null,
      targetPersonal: false,
    });
    expect(crossSpy).toHaveBeenCalledTimes(2);
    expect(crossSpy).toHaveBeenLastCalledWith({
      nodeId: 7,
      targetWorkspaceId: 8,
      targetParentId: null,
      targetPersonal: false,
      expected: 4,
      userId: 1,
    });
    expect(sameSpy).toHaveBeenCalledTimes(1);
  });
});
