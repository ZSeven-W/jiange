import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DriveUploadManager } from "@/pages/drive-upload";
import { HomeUpload } from "./HomeUpload";

describe("home upload entry", () => {
  it("prevents another selection while the session upload queue is active", () => {
    const uploads = new DriveUploadManager(1, () => {});
    const initial = uploads.snapshot();
    vi.spyOn(uploads, "snapshot").mockReturnValue({ ...initial, phase: "uploading" });
    const html = renderToStaticMarkup(<HomeUpload uploads={uploads} importing={false} onImport={() => {}} />);
    expect(html).toMatch(/<button[^>]*aria-haspopup="menu"[^>]*disabled=""/);
    expect(html).toContain("上传中");
  });

  it("also blocks uploads while an online document is being imported", () => {
    const uploads = new DriveUploadManager(1, () => {});
    const html = renderToStaticMarkup(<HomeUpload uploads={uploads} importing onImport={() => {}} />);
    expect(html).toMatch(/<button[^>]*aria-haspopup="menu"[^>]*disabled=""/);
  });
});
