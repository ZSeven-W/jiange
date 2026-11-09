import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FileCard, fileKind } from "./FileCard";

describe("Feishu file card", () => {
  it("colors the icon by file type", () => {
    expect(fileKind("a.pdf").label).toBe("PDF");
    expect(fileKind("b.XLSX").label).toBe("XLS");
    expect(fileKind("c.pptx").fg).toBe("#FF8800");
    expect(fileKind("noext").label).toBe("FILE");
  });
  it("shows size, type and hover actions when allowed", () => {
    const html = renderToStaticMarkup(<FileCard fileId="9" name="路线图.pdf" size="240045" canDownload onPreview={() => {}} />);
    expect(html).toContain("234 KB · PDF");
    expect(html).toContain("data-file-preview");
    expect(html).toContain('download="路线图.pdf"');
  });
  it("hides download when downloads are disabled", () => {
    const html = renderToStaticMarkup(<FileCard fileId="9" name="a.zip" size="10" canDownload={false} />);
    expect(html).toContain("下载已关闭");
    expect(html).not.toContain("/api/files/9");
    expect(html).not.toContain("data-file-preview");
  });
});
