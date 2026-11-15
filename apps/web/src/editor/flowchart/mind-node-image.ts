import { layoutMindTopics, type MindDescriptions, type MindStyles, type MindTopic } from "./mindmap";

/** Feishu copies the selected node alone, centred on an opaque square. */
export function mindNodeImageBounds(topics: readonly MindTopic[], collapsed: ReadonlySet<string>, styles: MindStyles, id: string, descriptions: MindDescriptions = {}) {
  const node = layoutMindTopics(topics, collapsed, styles, descriptions).find((item) => item.topic.id === id);
  if (!node) return null;
  const side = Math.ceil(Math.max(92, node.w + 12, node.h + 12));
  return { x: node.x + (node.w - side) / 2, y: node.y + (node.h - side) / 2, side, pixels: side * 2 };
}

/** Clone only the chosen node, never its parent, children, handles or selection. */
export function mindNodeImageSvg(svg: SVGSVGElement, id: string, bounds: { x: number; y: number; side: number; pixels: number }): string | null {
  const node = [...svg.querySelectorAll<SVGGElement>("[data-mind-topic]")].find((element) => element.getAttribute("data-mind-topic") === id);
  if (!node || node.querySelector("foreignObject")) return null;
  const clone = node.cloneNode(true) as SVGGElement;
  clone.querySelectorAll("[data-mind-outline],[data-mind-placeholder]").forEach((element) => element.remove());
  const result = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  result.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  result.setAttribute("width", String(bounds.pixels)); result.setAttribute("height", String(bounds.pixels));
  result.setAttribute("viewBox", `${bounds.x} ${bounds.y} ${bounds.side} ${bounds.side}`);
  result.setAttribute("font-family", svg.style.fontFamily || "-apple-system, BlinkMacSystemFont, sans-serif");
  const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  background.setAttribute("x", String(bounds.x)); background.setAttribute("y", String(bounds.y));
  background.setAttribute("width", String(bounds.side)); background.setAttribute("height", String(bounds.side)); background.setAttribute("fill", "#ffffff");
  result.append(background, clone);
  return new XMLSerializer().serializeToString(result);
}

export async function rasterizeMindNode(svg: string, pixels: number): Promise<Blob> {
  if (!Number.isSafeInteger(pixels) || pixels < 1 || pixels > 2048) throw new Error("invalid image size");
  const image = new Image(); image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  await image.decode();
  const canvas = document.createElement("canvas"); canvas.width = pixels; canvas.height = pixels;
  const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("canvas unavailable");
  ctx.drawImage(image, 0, 0, pixels, pixels);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("image encoding failed")), "image/png"));
}
