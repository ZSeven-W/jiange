import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Doc, ROOT, Tx } from "@jiange/collab";
import { draftTextPreview, PendingDraftPreview } from "./pending-draft-preview";

describe("local draft preview", () => {
  it("shows inserted text as text while keeping the full operation list in the backup", () => {
    const doc = new Doc(1), tx = new Tx(doc), a = tx.create("paragraph", null, ROOT), b = tx.create("paragraph", a, ROOT);
    tx.insert(a, 0, "<脚本>"); tx.insert(a, 4, "😀"); tx.insert(b, 0, "后续");
    const preview = draftTextPreview(tx.ops);
    expect(preview.text).toBe("<脚本>😀\n后续"); expect(preview.other).toBe(2);
    expect(draftTextPreview(tx.ops, 4)).toMatchObject({ text: "<脚本>", omitted: true });
    const html = renderToStaticMarkup(<PendingDraftPreview ops={tx.ops} onClose={() => {}} onDownload={() => {}} />);
    expect(html).toContain("&lt;脚本&gt;😀"); expect(html).not.toContain("<脚本>");
    expect(html).toContain("删除、格式和表格等操作请查看完整备份");
  });
});
