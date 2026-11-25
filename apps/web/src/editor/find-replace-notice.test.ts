import { describe, expect, it } from "vitest";
import { Doc, SyncClient, encodeServerMsg } from "@zseven-w/collab";
import { replacementSyncNotice, type ReplacementNotice } from "./find-replace-notice";

const deliver = (client: SyncClient, message: Parameters<typeof encodeServerMsg>[0]) => client.receive(encodeServerMsg(message));
function pendingReplacement() {
  const client = new SyncClient(1);
  client.open(() => {});
  deliver(client, { type: "welcome", clientId: 9, headSeq: 0, snapshot: { seq: 0, state: new Doc(9).encodeState() }, historyEpoch: 1 });
  const notice: ReplacementNotice = { count: 2, skipped: 1, historyChanges: client.droppedOnResync };
  const op = client.doc!.createBlock("paragraph");
  client.push([op]);
  return { client, notice };
}

describe("replacement synchronization feedback", () => {
  it("does not call a replacement synchronized until the data ACK and its fence are confirmed", () => {
    const { client, notice } = pendingReplacement();
    expect(replacementSyncNotice(notice, client)).toContain("正在同步");
    deliver(client, { type: "ack", firstSeq: 1, count: 1 });
    expect(replacementSyncNotice(notice, client)).toContain("正在同步");
    deliver(client, { type: "ack", firstSeq: 2, count: 0 });
    expect(replacementSyncNotice(notice, client)).toContain("2 处替换操作已同步");
    expect(replacementSyncNotice(notice, client)).toContain("1 处内容已变化并跳过");
    expect(replacementSyncNotice({ ...notice, skippedMentions: 2 }, client)).toContain("跳过 2 处提及内容");
    expect(replacementSyncNotice({ ...notice, skippedTitles: 1 }, client)).toContain("跳过 1 处标题");
    expect(replacementSyncNotice(notice, client)).toContain("并发修改");
    client.close();
    expect(replacementSyncNotice({ ...notice, acknowledged: true }, client)).toContain("替换操作已同步");
  });

  it("reports disconnected or rejected writes without claiming they were saved", () => {
    const disconnected = pendingReplacement();
    disconnected.client.close();
    expect(replacementSyncNotice(disconnected.notice, disconnected.client)).toContain("同步结果尚未确认");
    const rejected = pendingReplacement();
    deliver(rejected.client, { type: "error", code: "read_only", message: "denied" });
    expect(replacementSyncNotice(rejected.notice, rejected.client)).toContain("同步受阻");
    expect(replacementSyncNotice(rejected.notice, rejected.client)).not.toContain("已同步");
  });

  it("does not reuse confirmation after the document history changes", () => {
    const { client, notice } = pendingReplacement();
    client.close(); client.open(() => {});
    deliver(client, { type: "welcome", clientId: 9, headSeq: 0, snapshot: { seq: 0, state: new Doc(9).encodeState() }, historyEpoch: 2 });
    expect(replacementSyncNotice({ ...notice, acknowledged: true }, client)).toContain("历史已变化");
    expect(replacementSyncNotice(notice, client)).not.toContain("已同步");
  });
});
