import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Doc, ROOT } from "@jiange/collab";
import { findMatches } from "@/editor/find-replace";
import { TITLE } from "@/editor/model";
import { titleFindFlags, titleMirrorRange } from "./title-find";
import { CollabText } from "./collab-text";
import type { SyncDoc } from "@/lib/use-sync-doc";

function titleDoc() {
  const doc = new Doc(7);
  doc.apply({ t: "bcreate", id: TITLE, parent: ROOT, pos: "U", type: "title" });
  doc.insertText(TITLE, 0, "😀项目与项目");
  return doc;
}

describe("title search highlighting", () => {
  it("highlights the active and remaining matches at code-point offsets", () => {
    const doc = titleDoc(), matches = findMatches(doc, "项目");
    const flags = titleFindFlags(doc, TITLE, matches, matches[0]);
    expect(flags).toEqual([0, 2, 2, 0, 1, 1]);
    const html = renderToStaticMarkup(<>{titleMirrorRange([...doc.text(TITLE)], flags, 0, flags.length, "title")}</>);
    expect(html).toContain('data-find-active="true"');
    expect(html).toContain("😀");
    expect((html.match(/data-find-match/g) ?? [])).toHaveLength(2);
  });

  it("drops stale, moved or foreign matches without painting hidden source", () => {
    const doc = titleDoc(), matches = findMatches(doc, "项目");
    doc.insertText(TITLE, 2, "远端");
    const flags = titleFindFlags(doc, TITLE, matches, matches[0]);
    expect(flags.filter((flag) => flag === 2)).toHaveLength(0);
    expect(flags.filter((flag) => flag === 1)).toHaveLength(2);
    expect(titleFindFlags(titleDoc(), TITLE, matches, matches[0]).every((flag) => flag === 0)).toBe(true);
  });

  it("keeps a collaborator cursor visible when it falls inside a highlighted title", () => {
    const doc = titleDoc(), matches = findMatches(doc, "项目");
    const sync = { client: { doc }, peers: [{ clientId: 3, state: { name: "协作者", color: "#3370ff", cursor: { block: TITLE, anchor: doc.anchorAt(TITLE, 2) } } }] } as unknown as SyncDoc;
    const html = renderToStaticMarkup(<CollabText sync={sync} block={TITLE} me={{ name: "我", color: "#3370ff" }} findMatches={matches} activeFindMatch={matches[0]} />);
    expect(html).toContain('data-peer="协作者"');
    expect(html).toContain('data-find-active="true"');
    expect(html).toContain("😀");
  });
});
