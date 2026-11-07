import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ImagePreview } from "./OutlinePanel";

describe("image preview print permission", () => {
  it("marks restricted image bytes for the document print policy", () => {
    const restricted = renderToStaticMarkup(<ImagePreview src="/preview/1" alt="示例" allowPrint={false} onClose={() => {}} />);
    const allowed = renderToStaticMarkup(<ImagePreview src="/preview/1" alt="示例" allowPrint onClose={() => {}} />);
    expect(restricted).toContain('data-document-print-restricted="true"');
    expect(restricted).toContain('draggable="false"');
    expect(allowed).not.toContain("data-document-print-restricted");
    expect(allowed).toContain('draggable="true"');
  });
});
