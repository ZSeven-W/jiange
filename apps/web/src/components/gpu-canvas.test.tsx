import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { cssColorToRGBA, GpuLayer } from "./gpu-canvas";

describe("GpuLayer & cssColorToRGBA", () => {
  it("parses hex, 8-digit hex, rgb/rgba, and transparent colors cleanly", () => {
    expect(cssColorToRGBA("")).toEqual([0, 0, 0, 0]);
    expect(cssColorToRGBA("transparent")).toEqual([0, 0, 0, 0]);
    const blue = cssColorToRGBA("#3370ff");
    expect(blue[0]).toBeCloseTo(0x33 / 255, 3);
    expect(blue[2]).toBeCloseTo(1, 3);
    expect(blue[3]).toBe(1);
    const alphaHex = cssColorToRGBA("#ff880012");
    expect(alphaHex[0]).toBeCloseTo(1, 3);
    expect(alphaHex[3]).toBeCloseTo(0x12 / 255, 3);
    const rgb = cssColorToRGBA("rgba(51, 112, 255, 0.5)");
    expect(rgb[0]).toBeCloseTo(51 / 255, 3);
    expect(rgb[3]).toBeCloseTo(0.5, 3);
  });

  it("renders SSR-safe GPU canvas markup with telemetry data attributes", () => {
    const html = renderToStaticMarkup(
      <GpuLayer surfaceKind="sheet-grid" onRender={() => null} />,
    );
    expect(html).toContain('data-jiange-gpu="sheet-grid"');
    expect(html).toContain('data-gpu-backend="init"');
    expect(html).toContain('aria-hidden="true"');
  });
});
