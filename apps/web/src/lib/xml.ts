/**
 * Tiny non-validating XML parser for OOXML parts. It is deliberately strict
 * about well-formedness (mismatched tags throw) and refuses DOCTYPE
 * declarations, so no entity expansion can happen. Namespace prefixes are
 * kept verbatim (`w:p`), which is how OOXML is conventionally written.
 */

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}
export type XmlNode = XmlElement | string;

export class XmlError extends Error {}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new XmlError("invalid character reference");
      return String.fromCodePoint(code);
    }
    const value = ENTITIES[body];
    if (value === undefined) throw new XmlError(`unknown entity ${match}`);
    return value;
  });
}

const NAME = /[A-Za-z_:][-A-Za-z0-9_:.]*/y;
const ATTR = /\s+([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;

export function parseXml(source: string): XmlElement {
  let i = 0;
  if (source.charCodeAt(0) === 0xfeff) i = 1;
  const root: XmlElement = { name: "#document", attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  const n = source.length;
  while (i < n) {
    const lt = source.indexOf("<", i);
    if (lt < 0) {
      const tail = source.slice(i);
      if (stack.length > 1) throw new XmlError("unexpected end of document");
      if (tail.trim()) throw new XmlError("text outside root element");
      break;
    }
    if (lt > i) {
      const text = source.slice(i, lt);
      if (stack.length > 1) stack.at(-1)!.children.push(decodeEntities(text));
      else if (text.trim()) throw new XmlError("text outside root element");
    }
    if (source.startsWith("<?", lt)) {
      const end = source.indexOf("?>", lt + 2);
      if (end < 0) throw new XmlError("unterminated processing instruction");
      i = end + 2;
    } else if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      if (end < 0) throw new XmlError("unterminated comment");
      i = end + 3;
    } else if (source.startsWith("<![CDATA[", lt)) {
      const end = source.indexOf("]]>", lt + 9);
      if (end < 0 || stack.length < 2) throw new XmlError("invalid CDATA section");
      stack.at(-1)!.children.push(source.slice(lt + 9, end));
      i = end + 3;
    } else if (source.startsWith("<!", lt)) {
      throw new XmlError("DOCTYPE is not allowed");
    } else if (source[lt + 1] === "/") {
      NAME.lastIndex = lt + 2;
      const match = NAME.exec(source);
      if (!match) throw new XmlError("invalid closing tag");
      let p = NAME.lastIndex;
      while (p < n && /\s/.test(source[p])) p++;
      if (source[p] !== ">") throw new XmlError("invalid closing tag");
      const open = stack.pop();
      if (!open || open === root || open.name !== match[0]) throw new XmlError(`mismatched closing tag ${match[0]}`);
      i = p + 1;
    } else {
      NAME.lastIndex = lt + 1;
      const match = NAME.exec(source);
      if (!match) throw new XmlError("invalid tag");
      const element: XmlElement = { name: match[0], attrs: {}, children: [] };
      let p = NAME.lastIndex;
      for (;;) {
        ATTR.lastIndex = p;
        const attr = ATTR.exec(source);
        if (!attr) break;
        if (attr[1] in element.attrs) throw new XmlError("duplicate attribute");
        element.attrs[attr[1]] = decodeEntities(attr[2] ?? attr[3]);
        p = ATTR.lastIndex;
      }
      while (p < n && /\s/.test(source[p])) p++;
      const parent = stack.at(-1)!;
      if (parent === root && root.children.some((child) => typeof child !== "string")) throw new XmlError("multiple root elements");
      if (source.startsWith("/>", p)) {
        parent.children.push(element);
        i = p + 2;
      } else if (source[p] === ">") {
        parent.children.push(element);
        stack.push(element);
        i = p + 1;
      } else throw new XmlError("malformed tag");
      if (stack.length > 512) throw new XmlError("nesting too deep");
    }
  }
  if (stack.length !== 1) throw new XmlError("unclosed element");
  const top = root.children.find((child): child is XmlElement => typeof child !== "string");
  if (!top) throw new XmlError("empty document");
  return top;
}

export function child(element: XmlElement | undefined, name: string): XmlElement | undefined {
  return element?.children.find((c): c is XmlElement => typeof c !== "string" && c.name === name);
}

export function children(element: XmlElement | undefined, name?: string): XmlElement[] {
  if (!element) return [];
  return element.children.filter((c): c is XmlElement => typeof c !== "string" && (name === undefined || c.name === name));
}

export function textContent(element: XmlElement): string {
  return element.children.map((c) => (typeof c === "string" ? c : textContent(c))).join("");
}

/** Escape text for element content and attribute values; strips characters XML 1.0 forbids. */
export function escapeXml(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
