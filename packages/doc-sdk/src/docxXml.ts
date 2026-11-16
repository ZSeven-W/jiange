import { parseXml, XmlError, type XmlElement } from "./xml.js";

const XML = "http://www.w3.org/XML/1998/namespace";
const XMLNS = "http://www.w3.org/2000/xmlns/";
const NAMESPACES: Record<string, string> = {
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main": "w",
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships": "r",
  "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing": "wp",
  "http://schemas.openxmlformats.org/drawingml/2006/main": "a",
  "http://schemas.openxmlformats.org/markup-compatibility/2006": "mc",
  "http://schemas.openxmlformats.org/package/2006/relationships": "package",
  [XML]: "xml",
};

/** Canonicalize expanded names, not source prefixes. Unknown namespaces cannot impersonate Word names. */
export function parseDocxXml(source: string): XmlElement {
  const root = parseXml(source.replace(/\r\n?/g, "\n"), { maxNodes: 500_000 });
  const convert = (node: XmlElement, parent: Map<string, string>): XmlElement => {
    const scope = new Map(parent);
    for (const [key, value] of Object.entries(node.attrs)) {
      if (key === "xmlns") {
        if (value === XML || value === XMLNS) throw new XmlError("invalid default namespace");
        scope.set("", value);
      } else if (key.startsWith("xmlns:")) {
        const prefix = key.slice(6);
        if (!prefix || prefix.includes(":") || prefix === "xmlns" || !value || value === XMLNS || (prefix === "xml") !== (value === XML)) throw new XmlError("invalid namespace declaration");
        scope.set(prefix, value);
      }
    }
    const name = (raw: string, attribute: boolean): string => {
      const parts = raw.split(":");
      if (parts.length > 2 || parts.some((part) => !part)) throw new XmlError("invalid qualified name");
      if (parts.length === 1 && attribute) return parts[0];
      const namespace = parts.length === 1 ? scope.get("") ?? "" : scope.get(parts[0]);
      if (namespace === undefined) throw new XmlError("undeclared namespace prefix");
      const local = parts.at(-1)!;
      const prefix = Object.hasOwn(NAMESPACES, namespace) ? NAMESPACES[namespace] : undefined;
      if (prefix === "package" && !attribute) return local;
      if (prefix) return `${prefix}:${local}`;
      return `{${namespace}}${local}`;
    };
    const attrs: Record<string, string> = Object.create(null);
    for (const [key, value] of Object.entries(node.attrs)) {
      if (key === "xmlns" || key.startsWith("xmlns:")) continue;
      const expanded = name(key, true);
      if (Object.hasOwn(attrs, expanded)) throw new XmlError("duplicate expanded attribute");
      attrs[expanded] = value;
    }
    return { name: name(node.name, false), attrs, children: node.children.map((child) => typeof child === "string" ? child : convert(child, scope)) };
  };
  return convert(root, new Map([["xml", XML]]));
}
