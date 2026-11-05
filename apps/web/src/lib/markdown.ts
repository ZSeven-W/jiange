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

interface InlineRule {
  re: RegExp;
  marks: Record<string, string>;
  group?: string; // capture group carrying the link target
}

const INLINE_RULES: InlineRule[] = [
  { re: /\*\*\*(.+?)\*\*\*/, marks: { bold: "1", italic: "1" } },
  { re: /\*\*(.+?)\*\*/, marks: { bold: "1" } },
  { re: /\*(.+?)\*/, marks: { italic: "1" } },
  { re: /~~(.+?)~~/, marks: { strike: "1" } },
  { re: /`([^`]+)`/, marks: { code: "1" } },
  { re: /\[([^\]]+)\]\(([^)\s]+)\)/, marks: { link: "" }, group: "$2" },
];

/** Tokenize one line into spans carrying marks. */
export function parseInline(line: string): MdSpan[] {
  const spans: MdSpan[] = [];
  let plain = "";
  let i = 0;
  const push = () => {
    if (plain) spans.push({ text: unescapeInline(plain), marks: {} });
    plain = "";
  };
  while (i < line.length) {
    let matched = false;
    for (const rule of INLINE_RULES) {
      const m = line.slice(i).match(new RegExp(`^(?:${rule.re.source})`));
      if (!m) continue;
      push();
      const marks = { ...rule.marks };
      if (rule.group) marks.link = m[2];
      spans.push({ text: m[1], marks });
      i += m[0].length;
      matched = true;
      break;
    }
    if (!matched) {
      plain += line[i];
      i++;
    }
  }
  push();
  return spans;
}

/** Serialize spans back to inline markdown (link outermost, code innermost). */
export function serializeInline(spans: MdSpan[]): string {
  return spans
    .map((s) => {
      let t = escapeInline(s.text);
      if (s.marks.code) t = `\`${t}\``;
      if (s.marks.strike) t = `~~${t}~~`;
      if (s.marks.bold && s.marks.italic) t = `***${t}***`;
      else if (s.marks.bold) t = `**${t}**`;
      else if (s.marks.italic) t = `*${t}*`;
      if (s.marks.link) t = `[${t}](${s.marks.link})`;
      return t;
    })
    .join("");
}

const ESCAPABLE = /^([#>*+\-`\[\d])/;

function escapeInline(t: string): string {
  return t.replace(/([`])/g, "\\$1");
}

function unescapeInline(t: string): string {
  return t.replace(/\\([`\\])/g, "$1");
}

/** Escape a plain-text line so it cannot re-parse as a block/inline marker. */
function escapeLine(t: string): string {
  if (ESCAPABLE.test(t)) return "\\" + t;
  return t;
}

function unescapeLine(t: string): string {
  if (t.startsWith("\\") && ESCAPABLE.test(t.slice(1))) return t.slice(1);
  return t;
}

// ---------- block parsing ----------

export function parseMarkdown(md: string): MdBlock[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = unescapeLine(raw);
    if (line.trim() === "") {
      i++;
      continue;
    }
    // 块级公式 $$...$$（单行或多行到闭合 $$）
    if (line.trim() === "$$" || line.trim().startsWith("$$")) {
      const single = line.match(/^\$\$(.+)\$\$$/);
      if (single) {
        blocks.push({ type: "math", text: single[1].trim(), props: {}, spans: [] });
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
      blocks.push({ type: "math", text: body.join("\n").trim(), props: {}, spans: [] });
      continue;
    }
    // fenced code
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== "```") {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence (tolerate EOF)
      blocks.push({ type: "code", text: body.join("\n"), props: fence[1] ? { lang: fence[1] } : {}, spans: [] });
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      blocks.push({ type: "divider", text: "", props: {}, spans: [] });
      i++;
      continue;
    }
    const heading = line.match(/^(#{1,6}) +(.*)$/);
    if (heading) {
      blocks.push({ type: "h" + heading[1].length, text: heading[2], props: {}, spans: parseInline(heading[2]) });
      i++;
      continue;
    }
    if (line.startsWith("> ")) {
      blocks.push({ type: "quote", text: line.slice(2), props: {}, spans: parseInline(line.slice(2)) });
      i++;
      continue;
    }
    const img = line.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
    if (img) {
      blocks.push({ type: "image", text: "", props: { url: img[2], name: img[1] || "图片" }, spans: [] });
      i++;
      continue;
    }
    const file = line.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    if (file) {
      blocks.push({ type: "file", text: "", props: { url: file[2], name: file[1] }, spans: [] });
      i++;
      continue;
    }
    const list = line.match(/^(\s*)([-*+] \[[ xX]\]|[-*+]|\d+[.)]) +(.*)$/);
    if (list) {
      const indent = String(Math.min(4, Math.floor(list[1].replace(/\t/g, "  ").length / 2)));
      const marker = list[2];
      const text = list[3];
      if (/^[-*+] \[[ xX]\]$/.test(marker)) {
        blocks.push({ type: "todo", text, props: { indent, checked: /\[x/i.test(marker) ? "true" : "" }, spans: parseInline(text) });
      } else if (/^\d/.test(marker)) {
        blocks.push({ type: "ordered", text, props: { indent }, spans: parseInline(text) });
      } else {
        blocks.push({ type: "bullet", text, props: { indent }, spans: parseInline(text) });
      }
      i++;
      continue;
    }
    blocks.push({ type: "paragraph", text: line, props: {}, spans: parseInline(line) });
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
    const inline = b.spans.length ? serializeInline(b.spans) : b.text;
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
        out.push("```" + (b.props.lang ?? ""), b.text, "```");
        break;
      case "math":
        orderedNo = 0;
        if (b.text.includes("\n")) out.push("$$", b.text, "$$");
        else out.push(`$$${b.text}$$`);
        break;
      case "divider":
        orderedNo = 0;
        out.push("---");
        break;
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
