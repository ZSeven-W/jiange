import { parseMarkdown, type MdBlock } from "./markdown";

export interface ExtractedMarkdownImage {
  kind: "inline" | "reference" | "html";
  alt: string;
  title: string;
  src: string;
  isDataUri: boolean;
  safe: boolean;
  ref?: string;
}

export interface UploadedImageMeta {
  id: number | string;
  name?: string;
  mime?: string;
}

export interface ImportMarkdownImagesOptions {
  uploadImage?: (file: File) => Promise<UploadedImageMeta>;
  canContinue?: () => boolean;
}

export interface ImportMarkdownImagesResult {
  blocks: MdBlock[];
  images: ExtractedMarkdownImage[];
  uploadedCount: number;
  externalCount: number;
  skippedCount: number;
  warnings: string[];
}

const MAX_DATA_URI_BYTES = 20 * 1024 * 1024;
const INTERNAL_FILE_URL_RE = /^\/api\/files\/[1-9]\d*(\?version=[1-9]\d*)?$/;
const DATA_IMAGE_RE = /^data:(image\/(?:png|jpeg|jpg|gif|webp|avif|bmp));base64,([A-Za-z0-9+/=\s]+)$/i;
const REF_DEF_RE = /^\s{0,3}\[([^\]]+)\]:\s*(?:<([^>\s]+)>|(\S+))(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?\s*$/;

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
};

/** Accepts only safe http(s) URLs and authenticated internal `/api/files/{id}` URLs. */
export function isSafeMarkdownImageUrl(url?: string): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  if (!trimmed || /[\u0000-\u001f\u007f\s]/.test(trimmed)) return false;
  if (INTERNAL_FILE_URL_RE.test(trimmed)) return true;
  try {
    const parsed = new URL(trimmed);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host.length > 0;
  } catch {
    return false;
  }
}

function isSupportedDataImageUri(url: string): boolean {
  return DATA_IMAGE_RE.test(url.trim());
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos|#39);/gi, (match) => {
    switch (match.toLowerCase()) {
      case "&amp;":
        return "&";
      case "&lt;":
        return "<";
      case "&gt;":
        return ">";
      case "&quot;":
        return '"';
      case "&apos;":
      case "&#39;":
        return "'";
      default:
        return match;
    }
  });
}

function sanitizeImageFilename(alt: string | undefined, ext: string, index: number): string {
  const cleaned = (alt ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
  if (!cleaned) return `markdown-image-${index}.${ext}`;
  const lower = cleaned.toLowerCase();
  if (lower.endsWith(`.${ext}`) || (ext === "jpg" && lower.endsWith(".jpeg"))) return cleaned;
  return `${cleaned}.${ext}`;
}

function filenameFromUrl(url: string): string {
  try {
    const parsed = url.startsWith("/") ? new URL(url, "https://jiange.local") : new URL(url);
    const seg = decodeURIComponent(parsed.pathname.split("/").pop() ?? "").trim();
    if (seg && seg.length <= 80 && !/^\d+$/.test(seg)) return seg;
  } catch {
    /* ignore malformed URL */
  }
  return "";
}

/** Decode a safe raster `data:image/...;base64,...` URI into a browser File ready for upload. */
export function decodeDataUriImage(dataUri: string, alt?: string, index = 1): File | null {
  const match = dataUri.trim().match(DATA_IMAGE_RE);
  if (!match) return null;
  const rawMime = match[1].toLowerCase();
  const mime = rawMime === "image/jpg" ? "image/jpeg" : rawMime;
  const ext = EXT_BY_MIME[mime];
  if (!ext) return null;

  const base64 = match[2].replace(/\s+/g, "");
  if (!base64) return null;
  const estimatedBytes = Math.floor((base64.length * 3) / 4);
  if (estimatedBytes > MAX_DATA_URI_BYTES) return null;

  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    return null;
  }
  if (!binary.length || binary.length > MAX_DATA_URI_BYTES) return null;

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const filename = sanitizeImageFilename(alt, ext, index);
  return new File([bytes], filename, { type: mime });
}

interface RefDef {
  url: string;
  title: string;
  lineIndex: number;
}

interface LineImageToken {
  start: number;
  end: number;
  image: ExtractedMarkdownImage;
}

function parseDestAndTitle(raw: string): { src: string; title: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let src = "";
  let rest = "";
  if (trimmed.startsWith("<")) {
    const close = trimmed.indexOf(">");
    if (close <= 1) return null;
    src = trimmed.slice(1, close).trim();
    rest = trimmed.slice(close + 1).trim();
  } else {
    const ws = trimmed.search(/\s/);
    if (ws < 0) {
      src = trimmed;
    } else {
      src = trimmed.slice(0, ws);
      rest = trimmed.slice(ws + 1).trim();
    }
  }
  if (!src) return null;
  let title = "";
  if (rest) {
    const titleMatch = rest.match(/^(?:"([^"]*)"|'([^']*)'|\(([^)]*)\))$/);
    if (titleMatch) {
      title = titleMatch[1] ?? titleMatch[2] ?? titleMatch[3] ?? "";
    }
  }
  return { src, title };
}

function parseHtmlImgTag(tag: string): ExtractedMarkdownImage | null {
  const attrs: Record<string, string> = {};
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  const inner = tag.replace(/^<img\b/i, "").replace(/\/?>$/, "");
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(inner)) !== null) {
    const key = m[1].toLowerCase();
    const val = m[2] ?? m[3] ?? m[4] ?? "";
    attrs[key] = decodeHtmlEntities(val);
  }
  const src = (attrs.src ?? "").trim();
  if (!src) return null;
  const isDataUri = /^data:/i.test(src);
  return {
    kind: "html",
    alt: (attrs.alt ?? "").trim(),
    title: (attrs.title ?? "").trim(),
    src,
    isDataUri,
    safe: isDataUri ? isSupportedDataImageUri(src) : isSafeMarkdownImageUrl(src),
  };
}

function readBalancedParens(text: string, openIndex: number): number {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function readBracketLabel(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      i++;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function scanLineImages(line: string, refs: ReadonlyMap<string, RefDef>): LineImageToken[] {
  const tokens: LineImageToken[] = [];
  let i = 0;
  while (i < line.length) {
    // Skip inline code spans (`...`).
    if (line[i] === "`") {
      let ticks = 1;
      while (line[i + ticks] === "`") ticks++;
      const close = line.indexOf("`".repeat(ticks), i + ticks);
      if (close !== -1) {
        i = close + ticks;
        continue;
      }
      i += ticks;
      continue;
    }

    // Handle linked image badges: [![alt](imgUrl)](href)
    if (line[i] === "[" && line[i + 1] === "!" && line[i + 2] === "[") {
      const innerClose = readBracketLabel(line, i + 2);
      if (innerClose > i + 2 && line[innerClose + 1] === "(") {
        const innerParenClose = readBalancedParens(line, innerClose + 1);
        if (innerParenClose > innerClose + 1 && line[innerParenClose + 1] === "]" && line[innerParenClose + 2] === "(") {
          const outerParenClose = readBalancedParens(line, innerParenClose + 2);
          if (outerParenClose > innerParenClose + 2) {
            const parsed = parseDestAndTitle(line.slice(innerClose + 2, innerParenClose));
            if (parsed) {
              const alt = line.slice(i + 3, innerClose).trim();
              const isDataUri = /^data:/i.test(parsed.src);
              tokens.push({
                start: i,
                end: outerParenClose + 1,
                image: {
                  kind: "inline",
                  alt,
                  title: parsed.title,
                  src: parsed.src,
                  isDataUri,
                  safe: isDataUri ? isSupportedDataImageUri(parsed.src) : isSafeMarkdownImageUrl(parsed.src),
                },
              });
              i = outerParenClose + 1;
              continue;
            }
          }
        }
      }
    }

    // Markdown image: ![alt](url) or ![alt][ref] or ![alt][] or ![alt]
    if (line[i] === "!" && line[i + 1] === "[") {
      const closeBracket = readBracketLabel(line, i + 1);
      if (closeBracket > i + 1) {
        const alt = line.slice(i + 2, closeBracket).trim();
        const next = line[closeBracket + 1];
        if (next === "(") {
          const closeParen = readBalancedParens(line, closeBracket + 1);
          if (closeParen > closeBracket + 1) {
            const parsed = parseDestAndTitle(line.slice(closeBracket + 2, closeParen));
            if (parsed) {
              const isDataUri = /^data:/i.test(parsed.src);
              tokens.push({
                start: i,
                end: closeParen + 1,
                image: {
                  kind: "inline",
                  alt,
                  title: parsed.title,
                  src: parsed.src,
                  isDataUri,
                  safe: isDataUri ? isSupportedDataImageUri(parsed.src) : isSafeMarkdownImageUrl(parsed.src),
                },
              });
              i = closeParen + 1;
              continue;
            }
          }
        } else if (next === "[") {
          const refClose = readBracketLabel(line, closeBracket + 1);
          if (refClose > closeBracket + 1) {
            const rawRef = line.slice(closeBracket + 2, refClose).trim();
            const refKey = (rawRef || alt).toLowerCase();
            const def = refs.get(refKey);
            if (def) {
              const isDataUri = /^data:/i.test(def.url);
              tokens.push({
                start: i,
                end: refClose + 1,
                image: {
                  kind: "reference",
                  alt,
                  title: def.title,
                  src: def.url,
                  isDataUri,
                  safe: isDataUri ? isSupportedDataImageUri(def.url) : isSafeMarkdownImageUrl(def.url),
                  ref: rawRef || alt,
                },
              });
              i = refClose + 1;
              continue;
            }
          }
        } else if (alt) {
          // Shortcut reference image: ![alt] when [alt]: url is defined.
          const def = refs.get(alt.toLowerCase());
          if (def) {
            const isDataUri = /^data:/i.test(def.url);
            tokens.push({
              start: i,
              end: closeBracket + 1,
              image: {
                kind: "reference",
                alt,
                title: def.title,
                src: def.url,
                isDataUri,
                safe: isDataUri ? isSupportedDataImageUri(def.url) : isSafeMarkdownImageUrl(def.url),
                ref: alt,
              },
            });
            i = closeBracket + 1;
            continue;
          }
        }
      }
    }

    // HTML <img ...> tag
    if (line[i] === "<" && /^<img\b/i.test(line.slice(i))) {
      const tagMatch = line.slice(i).match(/^<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/i);
      if (tagMatch) {
        const parsed = parseHtmlImgTag(tagMatch[0]);
        if (parsed) {
          tokens.push({
            start: i,
            end: i + tagMatch[0].length,
            image: parsed,
          });
          i += tagMatch[0].length;
          continue;
        }
      }
    }

    i++;
  }
  return tokens;
}

type Segment =
  | { kind: "markdown"; text: string }
  | { kind: "image"; image: ExtractedMarkdownImage };

function segmentMarkdownWithImages(markdown: string): {
  segments: Segment[];
  images: ExtractedMarkdownImage[];
} {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");

  // Pass 1: collect reference definitions outside fenced code / math blocks.
  const refs = new Map<string, RefDef>();
  {
    let fence: { char: string; len: number } | null = null;
    let inMath = false;
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      if (!inMath) {
        if (!fence) {
          const openFence = line.match(/^\s*(`{3,}|~{3,})/);
          if (openFence) {
            fence = { char: openFence[1][0], len: openFence[1].length };
            continue;
          }
        } else {
          const closeRe = new RegExp(`^\\s*${fence.char}{${fence.len},}\\s*$`);
          if (closeRe.test(line)) fence = null;
          continue;
        }
      }
      const trimmed = line.trim();
      if (trimmed === "$$") {
        inMath = !inMath;
        continue;
      }
      if (inMath) continue;

      const defMatch = line.match(REF_DEF_RE);
      if (defMatch) {
        const key = defMatch[1].trim().toLowerCase();
        const url = (defMatch[2] ?? defMatch[3] ?? "").trim();
        const title = defMatch[4] ?? defMatch[5] ?? defMatch[6] ?? "";
        if (key && url && !refs.has(key)) {
          refs.set(key, { url, title, lineIndex: idx });
        }
      }
    }
  }

  // Pass 2: scan lines outside code/math for image tokens and record consumed ref lines.
  const lineTokens = new Map<number, LineImageToken[]>();
  const usedRefLines = new Set<number>();
  const images: ExtractedMarkdownImage[] = [];
  {
    let fence: { char: string; len: number } | null = null;
    let inMath = false;
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      if (!inMath) {
        if (!fence) {
          const openFence = line.match(/^\s*(`{3,}|~{3,})/);
          if (openFence) {
            fence = { char: openFence[1][0], len: openFence[1].length };
            continue;
          }
        } else {
          const closeRe = new RegExp(`^\\s*${fence.char}{${fence.len},}\\s*$`);
          if (closeRe.test(line)) fence = null;
          continue;
        }
      }
      const trimmed = line.trim();
      if (trimmed === "$$") {
        inMath = !inMath;
        continue;
      }
      if (inMath) continue;
      if (REF_DEF_RE.test(line)) continue;

      const tokens = scanLineImages(line, refs);
      if (tokens.length > 0) {
        lineTokens.set(idx, tokens);
        for (const token of tokens) {
          images.push(token.image);
          if (token.image.kind === "reference" && token.image.ref) {
            const def = refs.get(token.image.ref.toLowerCase());
            if (def) usedRefLines.add(def.lineIndex);
          }
        }
      }
    }
  }

  // Pass 3: emit ordered markdown + image segments.
  const segments: Segment[] = [];
  const mdBuffer: string[] = [];
  const flushMarkdown = () => {
    if (mdBuffer.length === 0) return;
    segments.push({ kind: "markdown", text: mdBuffer.join("\n") });
    mdBuffer.length = 0;
  };

  for (let idx = 0; idx < lines.length; idx++) {
    if (usedRefLines.has(idx)) continue;
    const tokens = lineTokens.get(idx);
    if (!tokens) {
      mdBuffer.push(lines[idx]);
      continue;
    }
    flushMarkdown();
    const line = lines[idx];
    let cursor = 0;
    for (const token of tokens) {
      const before = line.slice(cursor, token.start).trim();
      if (before && !/^[-*+>]+$/.test(before)) {
        segments.push({ kind: "markdown", text: before });
      }
      segments.push({ kind: "image", image: token.image });
      cursor = token.end;
    }
    const after = line.slice(cursor).trim();
    if (after) {
      segments.push({ kind: "markdown", text: after });
    }
  }
  flushMarkdown();

  return { segments, images };
}

/** Extract all Markdown inline, reference-style, and HTML `<img>` images outside code/math blocks. */
export function extractMarkdownImages(markdown: string): ExtractedMarkdownImage[] {
  return segmentMarkdownWithImages(markdown).images;
}

/**
 * Parse Markdown into native CRDT block seeds while resolving images:
 * - `data:image/...;base64,...` inline images are decoded and uploaded via `uploadImage` into `{ fileId, name, caption }` blocks.
 * - Safe `https://`, `http://`, and `/api/files/...` URLs become `{ url, name, caption }` blocks.
 * - Unsafe schemes (`javascript:`, `vbscript:`, SVG data URIs, etc.) are cleanly rejected with warnings.
 */
export async function importMarkdownBlocksWithImages(
  markdown: string,
  optionsOrUpload?: ImportMarkdownImagesOptions | ((file: File) => Promise<UploadedImageMeta>),
): Promise<ImportMarkdownImagesResult> {
  const options: ImportMarkdownImagesOptions =
    typeof optionsOrUpload === "function" ? { uploadImage: optionsOrUpload } : (optionsOrUpload ?? {});
  const { uploadImage, canContinue } = options;

  const { segments, images } = segmentMarkdownWithImages(markdown);
  const blocks: MdBlock[] = [];
  const warnings: string[] = [];
  const uploadedByDataUri = new Map<string, UploadedImageMeta>();
  let uploadedCount = 0;
  let externalCount = 0;
  let skippedCount = 0;
  let imageIndex = 0;

  for (const seg of segments) {
    if (canContinue && !canContinue()) throw new Error("document unavailable");
    if (seg.kind === "markdown") {
      const parsed = parseMarkdown(seg.text);
      for (const block of parsed) {
        // Safety net in case any standalone image slipped through parseMarkdown.
        if (block.type === "image" && !isSafeMarkdownImageUrl(block.props.url)) {
          skippedCount++;
          warnings.push(`已跳过不安全或不受支持的图片链接：${block.props.name || "图片"}`);
          continue;
        }
        blocks.push(block);
      }
      continue;
    }

    imageIndex++;
    const img = seg.image;
    const caption = img.title || img.alt || "";

    if (img.isDataUri) {
      if (!img.safe) {
        skippedCount++;
        warnings.push(`已跳过不受支持的内嵌图片格式：${img.alt || "图片"}`);
        continue;
      }
      const file = decodeDataUriImage(img.src, img.alt, imageIndex);
      if (!file) {
        skippedCount++;
        warnings.push(`已跳过无法解码的内嵌图片：${img.alt || "图片"}`);
        continue;
      }
      if (!uploadImage) {
        skippedCount++;
        warnings.push(`未配置图片上传服务，已跳过内嵌图片：${img.alt || file.name}`);
        continue;
      }
      try {
        let meta = uploadedByDataUri.get(img.src);
        if (!meta) {
          meta = await uploadImage(file);
          if (canContinue && !canContinue()) throw new Error("document unavailable");
          if (!meta || !/^[1-9]\d*$/.test(String(meta.id))) {
            throw new Error("image upload not confirmed");
          }
          uploadedByDataUri.set(img.src, meta);
        }
        const props: Record<string, string> = {
          fileId: String(meta.id),
          mime: meta.mime || file.type,
          name: img.alt || meta.name || file.name,
        };
        if (caption) props.caption = caption;
        blocks.push({ type: "image", text: "", props, spans: [] });
        uploadedCount++;
      } catch (err) {
        if (err instanceof Error && err.message === "document unavailable") throw err;
        skippedCount++;
        warnings.push(`内嵌图片上传失败，已跳过：${img.alt || file.name}`);
      }
      continue;
    }

    if (img.safe && isSafeMarkdownImageUrl(img.src)) {
      const url = img.src.trim();
      const name = img.alt || img.title || filenameFromUrl(url) || "图片";
      const props: Record<string, string> = { url, name };
      if (caption) props.caption = caption;
      blocks.push({ type: "image", text: "", props, spans: [] });
      externalCount++;
      continue;
    }

    skippedCount++;
    warnings.push(`已跳过不安全或不受支持的图片链接：${img.alt || img.src.slice(0, 48)}`);
  }

  return {
    blocks,
    images,
    uploadedCount,
    externalCount,
    skippedCount,
    warnings,
  };
}
