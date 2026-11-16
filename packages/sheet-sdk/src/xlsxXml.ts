import { parseXml, type XmlElement } from "@jiange/ooxml/xml";
import { XlsxError } from "./xlsx.js";

export interface XlsxXmlNode { name: string; ns: string; attrs: Record<string, string>; children: (XlsxXmlNode | string)[] }
const XML_NS = "http://www.w3.org/XML/1998/namespace";

/** Resolve namespace prefixes without a browser DOM; default namespaces do not apply to attributes. */
export function xlsxXml(source: string): XlsxXmlNode {
  const convert = (node: XmlElement, parent: Map<string, string>): XlsxXmlNode => {
    const scope = new Map(parent);
    for (const [key, value] of Object.entries(node.attrs)) {
      if (key === "xmlns") scope.set("", value);
      else if (key.startsWith("xmlns:")) {
        const prefix = key.slice(6);
        if (!prefix || prefix.includes(":") || prefix === "xmlns" || (prefix === "xml" && value !== XML_NS)) throw new XlsxError("invalid XML namespace");
        scope.set(prefix, value);
      }
    }
    const expand = (raw: string, attribute: boolean): [string, string] => {
      const parts = raw.split(":");
      if (parts.length > 2 || parts.some((part) => !part)) throw new XlsxError("invalid XML qualified name");
      if (parts.length === 1) return [attribute ? "" : scope.get("") ?? "", parts[0]];
      const ns = scope.get(parts[0]); if (!ns) throw new XlsxError("undeclared XML namespace");
      return [ns, parts[1]];
    };
    const [ns, name] = expand(node.name, false), attrs: Record<string, string> = Object.create(null);
    for (const [key, value] of Object.entries(node.attrs)) {
      if (key === "xmlns" || key.startsWith("xmlns:")) continue;
      const [attrNS, attr] = expand(key, true), full = `${attrNS}|${attr}`;
      if (Object.hasOwn(attrs, full)) throw new XlsxError("duplicate XML attribute");
      attrs[full] = value;
    }
    return { name, ns, attrs, children: node.children.map((entry) => typeof entry === "string" ? entry : convert(entry, scope)) };
  };
  // XML parsers normalize literal CR/CRLF before resolving character references.
  return convert(parseXml(source.replace(/\r\n?/g, "\n"), { maxNodes: 250_000 }), new Map([["xml", XML_NS]]));
}
export const xattr = (node: XlsxXmlNode, name: string, ns = "") => node.attrs[`${ns}|${name}`];
export const xchildren = (node: XlsxXmlNode, name?: string, ns = node.ns): XlsxXmlNode[] => node.children.filter((value): value is XlsxXmlNode => typeof value !== "string" && value.ns === ns && (name === undefined || value.name === name));
export const xchild = (node: XlsxXmlNode, name: string, ns = node.ns): XlsxXmlNode | undefined => xchildren(node, name, ns)[0];
export const xtext = (node: XlsxXmlNode): string => node.children.map((value) => typeof value === "string" ? value : xtext(value)).join("");
