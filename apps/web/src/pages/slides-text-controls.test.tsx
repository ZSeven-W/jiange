import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { bodyHasBullets, toggleBodyBullets } from "./slides-text-style";
import { SlideTextControls } from "./slides-text-controls";

describe("slide text formatting helpers and controls", () => {
  it("toggles bullet prefixes on multi-line body text cleanly", () => {
    expect(bodyHasBullets("第一条\n第二条")).toBe(false);
    const bulleted = toggleBodyBullets("第一条\n第二条");
    expect(bulleted).toBe("• 第一条\n• 第二条");
    expect(bodyHasBullets(bulleted)).toBe(true);
    expect(toggleBodyBullets(bulleted)).toBe("第一条\n第二条");
    expect(toggleBodyBullets("")).toBe("• ");
  });

  it("renders floating Feishu text controls for title and body with bullet toggle on body", () => {
    const titleHtml = renderToStaticMarkup(
      <SlideTextControls
        target="title"
        style={{ fontSize: 44, bold: true }}
        defaultFontSize={36}
        defaultBold={true}
        defaultAlign="left"
        defaultColor="#1f2329"
        onChange={() => {}}
        onReset={() => {}}
      />,
    );
    expect(titleHtml).toContain('data-slides-text-controls="title"');
    expect(titleHtml).toContain('aria-label="文本格式"');
    expect(titleHtml).toContain("44px");
    expect(titleHtml).not.toContain('aria-label="项目符号列表"');

    const bodyHtml = renderToStaticMarkup(
      <SlideTextControls
        target="body"
        style={{ italic: true, align: "center" }}
        defaultFontSize={21}
        defaultBold={false}
        defaultAlign="left"
        defaultColor="#1f2329"
        bulleted={true}
        onChange={() => {}}
        onReset={() => {}}
        onToggleBullet={() => {}}
      />,
    );
    expect(bodyHtml).toContain('data-slides-text-controls="body"');
    expect(bodyHtml).toContain('aria-label="项目符号列表"');
    expect(bodyHtml).toContain('aria-pressed="true"');
  });
});
