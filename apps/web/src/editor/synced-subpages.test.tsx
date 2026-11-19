import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { filterItems } from "./pinyin";
import { SyncedBlockView } from "./synced-block";
import { SubpagesBlockView } from "./subpages-block";

describe("synced block and subpages list block", () => {
  it("registers synced and subpages items in slash menu with pinyin and English aliases", () => {
    expect(filterItems("tongbu").some((it) => it.id === "synced")).toBe(true);
    expect(filterItems("synced").some((it) => it.id === "synced")).toBe(true);
    expect(filterItems("ziyemian").some((it) => it.id === "subpages")).toBe(true);
    expect(filterItems("subpages").some((it) => it.id === "subpages")).toBe(true);
  });

  it("renders empty synced block setup controls and bound synced block chrome", () => {
    const emptyHtml = renderToStaticMarkup(
      <SyncedBlockView docId={1} readOnly={false} onBindSyncId={() => {}} onDelete={() => {}} />,
    );
    expect(emptyHtml).toContain("data-synced-block-empty");
    expect(emptyHtml).toContain("data-create-synced-block");
    expect(emptyHtml).toContain("data-link-synced-input");

    const boundHtml = renderToStaticMarkup(
      <SyncedBlockView syncId="sb_demo123" docId={1} readOnly={false} onDelete={() => {}} />,
    );
    expect(boundHtml).toContain('data-synced-block="sb_demo123"');
    expect(boundHtml).toContain("data-copy-synced-id");
    expect(boundHtml).toContain("data-refresh-synced");
  });

  it("renders subpages block with create shortcut for editors and hides it in readOnly mode", () => {
    const editHtml = renderToStaticMarkup(<SubpagesBlockView docId={1} readOnly={false} onDelete={() => {}} />);
    expect(editHtml).toContain("data-subpages-block");
    expect(editHtml).toContain("data-create-subpage");

    const roHtml = renderToStaticMarkup(<SubpagesBlockView docId={1} readOnly={true} />);
    expect(roHtml).toContain("data-subpages-block");
    expect(roHtml).not.toContain("data-create-subpage");
  });
});
