/**
 * Markdown import/export for Jiange documents (P6).
 *
 * Covers: h1-h3, bullet/ordered/todo lists with indentation, quote, fenced
 * code, divider, bold/italic/strikethrough/inline-code/link marks, images and
 * attachment links. Export escapes text that would re-parse as markup, which
 * keeps md → doc → md idempotent.
 */

export interface MdSpan {
  text: string;
  marks: Record<string, string>;
}

export interface MdBlock {
  type: string; // paragraph | h1 | h2 | h3 | bullet | ordered | todo | quote | code | divider | image | file
  text: string;
  props: Record<string, string>;
  spans: MdSpan[];
}

// ---------- inline marks ----------

// Backslash escapes are decoded *after* syntax has been identified. Decoding
// first would turn ordinary text such as "\\# 标题" into a heading.
const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

function unescapeMarkdown(text: string): string {
  return text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
}

/** Find an unescaped delimiter; escaped punctuation never opens or closes a mark. */
function closingDelimiter(text: string, from: number, delimiter: string): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\\" && i + 1 < text.length && ESCAPABLE.test(text[i + 1])) { i++; continue; }
    if (text[i] === "`") {
      let size = 1;
      while (text[i + size] === "`") size++;
      const end = text.indexOf("`".repeat(size), i + size);
      if (end !== -1) { i = end + size - 1; continue; }
    }
    if (text.startsWith(delimiter, i)) return i;
  }
  return -1;
}

/** Parse a link with escaped brackets and balanced URL parentheses. */
function linkAt(text: string, start: number, close: number, cache: Map<number, { url: string; end: number } | null>): { label: string; url: string; end: number } | null {
  if (close < 0 || text[close + 1] !== "(") return null;
  if (cache.has(close)) {
    const destination = cache.get(close);
    return destination ? { label: text.slice(start + 1, close), ...destination } : null;
  }
  let depth = 1;
  for (let i = close + 2; i < text.length; i++) {
    if (text[i] === "\\" && i + 1 < text.length && ESCAPABLE.test(text[i + 1])) { i++; continue; }
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) {
      const url = text.slice(close + 2, i);
      if (!url || /\s/.test(url)) { cache.set(close, null); return null; }
      const destination = { url: unescapeMarkdown(url), end: i + 1 };
      cache.set(close, destination);
      return { label: text.slice(start + 1, close), ...destination };
    }
  }
  cache.set(close, null);
  return null;
}

/** Index possible label endings once, avoiding repeated scans on malformed input. */
function linkClosers(text: string): Int32Array {
  const closers: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && i + 1 < text.length && ESCAPABLE.test(text[i + 1])) { i++; continue; }
    if (text[i] === "`") {
      let size = 1;
      while (text[i + size] === "`") size++;
      const end = text.indexOf("`".repeat(size), i + size);
      if (end !== -1) { i = end + size - 1; continue; }
    }
    if (text[i] === "]") closers.push(i);
  }
  const next = new Int32Array(text.length + 1);
  let candidate = closers.length - 1, nearest = -1;
  for (let i = text.length; i >= 0; i--) {
    if (candidate >= 0 && closers[candidate] === i) nearest = closers[candidate--];
    next[i] = nearest;
  }
  return next;
}

/** Tokenize one line recursively, preserving escaped text and nested marks. */
export function parseInline(line: string): MdSpan[] {
  const spans: MdSpan[] = [];
  const append = (text: string, marks: Record<string, string>) => {
    if (!text) return;
    const previous = spans.at(-1);
    if (previous && JSON.stringify(previous.marks) === JSON.stringify(marks)) previous.text += text;
    else spans.push({ text, marks: { ...marks } });
  };
  const parse = (text: string, marks: Record<string, string>, depth: number) => {
    // Keep pathological nesting bounded. Remaining text remains literal.
    if (depth > 32) { append(unescapeMarkdown(text), marks); return; }
    const closers = text.includes("[") ? linkClosers(text) : null;
    const linkCache = new Map<number, { url: string; end: number } | null>();
    let plain = "";
    const flush = () => { append(plain, marks); plain = ""; };
    for (let i = 0; i < text.length;) {
      if (text[i] === "\\" && i + 1 < text.length && ESCAPABLE.test(text[i + 1])) {
        plain += text[i + 1]; i += 2; continue;
      }
      if (text[i] === "`") {
        let size = 1;
        while (text[i + size] === "`") size++;
        const ticks = "`".repeat(size), end = text.indexOf(ticks, i + size);
        if (end > i + size) {
          flush();
          let body = text.slice(i + size, end);
          if (body.startsWith(" ") && body.endsWith(" ") && /\S/.test(body)) body = body.slice(1, -1);
          append(body, { ...marks, code: "1" });
          i = end + size; continue;
        }
      }
      if (text[i] === "[") {
        const link = linkAt(text, i, closers![i + 1], linkCache);
        if (link && link.label) { flush(); parse(link.label, { ...marks, link: link.url }, depth + 1); i = link.end; continue; }
      }
      // A valid Markdown comment separates adjacent formatting delimiters
      // without adding content to the rendered document.
      if (text.startsWith("<!-- -->", i)) { i += 8; continue; }
      let found = false;
      for (const [delimiter, extra] of [
        ["***", { bold: "1", italic: "1" }], ["___", { bold: "1", italic: "1" }],
        ["**", { bold: "1" }], ["__", { bold: "1" }],
        ["~~", { strike: "1" }], ["*", { italic: "1" }], ["_", { italic: "1" }],
      ] as const) {
        if (!text.startsWith(delimiter, i)) continue;
        const end = closingDelimiter(text, i + delimiter.length, delimiter);
        if (end <= i + delimiter.length) continue;
        flush(); parse(text.slice(i + delimiter.length, end), { ...marks, ...extra }, depth + 1);
        i = end + delimiter.length; found = true; break;
      }
      if (!found) { plain += text[i]; i++; }
    }
    flush();
  };
  parse(line, {}, 0);
  return spans;
}

/** Serialize spans back to inline markdown (link outermost, code innermost). */
export function serializeInline(spans: MdSpan[]): string {
  const pieces = spans
    .map((s) => {
      let t = escapeInline(s.text);
      if (s.marks.code) {
        let longest = 0;
        for (const match of s.text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
        const ticks = "`".repeat(longest + 1);
        const padded = s.text.startsWith("`") || s.text.endsWith("`") || (s.text.startsWith(" ") && s.text.endsWith(" ") && /\S/.test(s.text));
        t = `${ticks}${padded ? " " : ""}${s.text}${padded ? " " : ""}${ticks}`;
      }
      if (s.marks.strike) t = `~~${t}~~`;
      if (s.marks.bold && s.marks.italic) t = `***${t}***`;
      else if (s.marks.bold) t = `**${t}**`;
      else if (s.marks.italic) t = `*${t}*`;
      if (s.marks.link) t = `[${t}](${s.marks.link.replace(/[\\()]/g, "\\$&")})`;
      return t;
    });
  let result = "";
  for (const piece of pieces) {
    if (result && piece && /[*_~`]$/.test(result) && result.at(-1) === piece[0]) result += "<!-- -->";
    result += piece;
  }
  return result;
}

function escapeInline(t: string): string {
  return t.replace(/[\\`*_\[\]<>~!#$|]/g, "\\$&");
}

/** Escape a plain-text line so it cannot re-parse as a block/inline marker. */
function escapeLine(t: string): string {
  return t.replace(/^(\s*)([-+])(?=\s)/, "$1\\$2")
    .replace(/^(\s*)(\d+)([.)])(?=\s)/, "$1$2\\$3")
    .replace(/^(\s*)(-{3,})(?=\s*$)/, "$1\\$2");
}

function codeFence(text: string): string {
  let longest = 2;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return "`".repeat(longest + 1);
}

/** A table is editable only as a rectangular grid of strings in the editor. */
export function markdownTableRows(data: string | undefined): string[][] | null {
  if (data === undefined || data === "") return [["列 1", "列 2", "列 3"], ["", "", ""]];
  try {
    const rows: unknown = JSON.parse(data);
    if (!Array.isArray(rows) || !rows.length || !Array.isArray(rows[0]) || !rows[0].length) return null;
    const width = rows[0].length;
    if (rows.some((row) => !Array.isArray(row) || row.length !== width || row.some((cell: unknown) => typeof cell !== "string"))) return null;
    return rows as string[][];
  } catch { return null; }
}

// Escape text rather than emit Markdown marks: table cells in the document
// model are plain strings, including characters that look like Markdown.
function tableCellToMarkdown(cell: string): string {
  return cell.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\").replace(/([|`*_\[\]!~])/g, "\\$1")
    .replace(/\r/g, "&#13;").replace(/\n/g, "<br>").replace(/\t/g, "&#9;")
    .replace(/^\s+|\s+$/gu, (whitespace) => Array.from(whitespace, (character) => `&#${character.codePointAt(0)};`).join(""));
}

function tableCellFromMarkdown(cell: string): string {
  // Decode once, so a literal "&lt;" serialized as "&amp;lt;" stays literal.
  const entities: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
  const input = cell.trim();
  let result = "";
  for (let i = 0; i < input.length;) {
    if (input[i] === "\\" && i + 1 < input.length && ESCAPABLE.test(input[i + 1])) {
      result += input[i + 1]; i += 2; continue;
    }
    const match = (input[i] === "<" || input[i] === "&")
      ? input.slice(i).match(/^(?:<br\s*\/?\s*>|&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i)?.[0] : undefined;
    if (!match) { result += input[i++]; continue; }
    if (/^<br/i.test(match)) result += "\n";
    else if (match.startsWith("&#")) {
      const hex = /^&#x/i.test(match);
      const codepoint = Number.parseInt(match.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
      result += codepoint >= 0 && codepoint <= 0x10ffff && !(codepoint >= 0xd800 && codepoint <= 0xdfff)
        ? String.fromCodePoint(codepoint) : match;
    } else result += entities[match.toLowerCase()] ?? match;
    i += match.length;
  }
  return result;
}

/** Split only on unescaped pipe characters. Keep escapes for later decoding. */
function tableRow(line: string): string[] | null {
  const trimmed = line.trim();
  let cell = "", hasPipe = false;
  const cells: string[] = [];
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "\\" && i + 1 < trimmed.length) { cell += ch + trimmed[++i]; continue; }
    if (ch === "|") { hasPipe = true; cells.push(cell); cell = ""; }
    else cell += ch;
  }
  cells.push(cell);
  if (!hasPipe) return null;
  if (trimmed.startsWith("|")) cells.shift();
  if (trimmed.endsWith("|") && cells.at(-1) === "") cells.pop();
  return cells;
}

function tableAsMarkdown(rows: string[][]): string[] {
  const row = (cells: string[]) => `| ${cells.map(tableCellToMarkdown).join(" | ")} |`;
  return [row(rows[0]), row(rows[0].map(() => "---")), ...rows.slice(1).map(row)];
}

// ---------- block parsing ----------

export function parseMarkdown(md: string): MdBlock[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw;
    if (line.trim() === "") {
      i++;
      continue;
    }
    // 块级公式 $$...$$（单行或多行到闭合 $$）
    if (line.trim() === "$$" || line.trim().startsWith("$$")) {
      const single = line.match(/^\$\$(.*)\$\$$/);
      if (single) {
        blocks.push({ type: "math", text: single[1], props: {}, spans: [] });
        i++;
        continue;
      }
      const body: string[] = [];
      if (line.trim().length > 2) body.push(line.trim().slice(2));
      i++;
      while (i < lines.length && lines[i].trim() !== "$$") {
        body.push(lines[i]);
        i++;
      }
      i++; // closing $$
      blocks.push({ type: "math", text: body.join("\n"), props: {}, spans: [] });
      continue;
    }
    // fenced code
    const fence = line.match(/^(`{3,})([^\s`]*)\s*$/);
    if (fence) {
      const body: string[] = [];
      const closing = new RegExp(`^\\s*\u0060{${fence[1].length},}\\s*$`);
      i++;
      while (i < lines.length && !closing.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence (tolerate EOF)
      if (fence[2] === "mermaid") {
        blocks.push({ type: "diagram", text: body.join("\n"), props: {}, spans: [] });
      } else {
        blocks.push({ type: "code", text: body.join("\n"), props: fence[2] ? { lang: fence[2] } : {}, spans: [] });
      }
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      blocks.push({ type: "divider", text: "", props: {}, spans: [] });
      i++;
      continue;
    }
    const heading = line.match(/^(#{1,6}) +(.*)$/);
    if (heading) {
      const spans = parseInline(heading[2]);
      blocks.push({ type: "h" + heading[1].length, text: spans.map(s => s.text).join(""), props: {}, spans });
      i++;
      continue;
    }
    if (line.startsWith("> ")) {
      const spans = parseInline(line.slice(2));
      blocks.push({ type: "quote", text: spans.map(s => s.text).join(""), props: {}, spans });
      i++;
      continue;
    }
    const img = line.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
    if (img) {
      blocks.push({ type: "image", text: "", props: { url: img[2], name: img[1] || "图片" }, spans: [] });
      i++;
      continue;
    }
    const list = line.match(/^(\s*)([-*+] \[[ xX]\]|[-*+]|\d+[.)]) +(.*)$/);
    if (list) {
      const indent = String(Math.min(4, Math.floor(list[1].replace(/\t/g, "  ").length / 2)));
      const marker = list[2];
      const spans = parseInline(list[3]);
      const text = spans.map(s => s.text).join("");
      if (/^[-*+] \[[ xX]\]$/.test(marker)) {
        blocks.push({ type: "todo", text, props: { indent, checked: /\[x/i.test(marker) ? "true" : "" }, spans });
      } else if (/^\d/.test(marker)) {
        blocks.push({ type: "ordered", text, props: { indent }, spans });
      } else {
        blocks.push({ type: "bullet", text, props: { indent }, spans });
      }
      i++;
      continue;
    }
    // GFM-style table: recognize only after higher-priority block syntax, so
    // a fenced code block or heading containing a pipe is not swallowed.
    // Do not consume cells that exceed the header width.
    const header = tableRow(line);
    const divider = i + 1 < lines.length ? tableRow(lines[i + 1]) : null;
    if (header?.length && divider && divider.length === header.length && divider.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))) {
      const rows = [header.map(tableCellFromMarkdown)];
      i += 2;
      while (i < lines.length) {
        const row = tableRow(lines[i]);
        if (!row || row.length > header.length) break;
        const values = row.map(tableCellFromMarkdown);
        while (values.length < header.length) values.push("");
        rows.push(values);
        i++;
      }
      blocks.push({ type: "table", text: "", props: { tableData: JSON.stringify(rows) }, spans: [] });
      continue;
    }
    const spans = parseInline(line);
    blocks.push({ type: "paragraph", text: spans.map(s => s.text).join(""), props: {}, spans });
    i++;
  }
  return blocks;
}

// ---------- block serialization ----------

export function toMarkdown(blocks: MdBlock[]): string {
  const out: string[] = [];
  let orderedNo = 0;
  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k];
    const pad = "  ".repeat(Number(b.props.indent ?? 0));
    const inline = serializeInline(b.spans.length ? b.spans : [{ text: b.text, marks: {} }]);
    switch (b.type) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        orderedNo = 0;
        out.push(`${"#".repeat(Number(b.type[1]))} ${inline}`);
        break;
      case "quote":
        orderedNo = 0;
        out.push(`> ${inline}`);
        break;
      case "code":
        orderedNo = 0;
        {
          const fence = codeFence(b.text);
          out.push(fence + (b.props.lang ?? ""), b.text, fence);
        }
        break;
      case "math":
        orderedNo = 0;
        if (b.text.includes("\n")) out.push("$$", b.text, "$$");
        else out.push(`$$${b.text}$$`);
        break;
      case "diagram":
        orderedNo = 0;
        {
          const fence = codeFence(b.text);
          out.push(fence + "mermaid", b.text, fence);
        }
        break;
      case "divider":
        orderedNo = 0;
        out.push("---");
        break;
      case "table": {
        orderedNo = 0;
        const rows = markdownTableRows(b.props.tableData);
        if (rows) out.push("", ...tableAsMarkdown(rows), "");
        else {
          // Preserve malformed/legacy source instead of silently discarding it.
          const source = b.props.tableData ?? "";
          const fence = codeFence(source);
          out.push(fence + "json", source, fence);
        }
        break;
      }
      case "image":
        orderedNo = 0;
        out.push(`![${b.props.name ?? "图片"}](${b.props.url ?? ""})`);
        break;
      case "file":
        orderedNo = 0;
        out.push(`[${b.props.name ?? (b.text || "附件")}](${b.props.url ?? ""})`);
        break;
      case "bullet":
        orderedNo = 0;
        out.push(`${pad}- ${inline}`);
        break;
      case "todo":
        orderedNo = 0;
        out.push(`${pad}- [${b.props.checked === "true" ? "x" : " "}] ${inline}`);
        break;
      case "ordered":
        orderedNo += 1;
        out.push(`${pad}${orderedNo}. ${inline}`);
        break;
      default:
        orderedNo = 0;
        out.push(escapeLine(inline));
    }
  }
  return out.join("\n") + "\n";
}

/** DocView blocks (from the collab model) → MdBlocks, skipping the title. */
export function viewToMarkdown(view: { blocks: { type: string; props: Record<string, string>; spans: MdSpan[] }[] }): string {
  return toMarkdown(
    view.blocks
      .filter((b) => b.type !== "title")
      .map((b) => ({ type: b.type, text: b.spans.map((s) => s.text).join(""), props: b.props, spans: b.spans })),
  );
}
