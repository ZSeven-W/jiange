import type { ReactNode } from "react";
import type { TableRichSpan } from "./table-cells";

export function renderTableRichSpans(spans: readonly TableRichSpan[]): ReactNode {
  if (!spans.length) return null;
  return spans.map((span, idx) => {
    const m = span.marks;
    if (!m || !Object.keys(m).length) return <span key={idx}>{span.text}</span>;
    let node: ReactNode = span.text;
    if (m.code) {
      node = (
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">
          {node}
        </code>
      );
    }
    if (m.strike) node = <s className="line-through">{node}</s>;
    if (m.underline) node = <u className="underline">{node}</u>;
    if (m.italic) node = <em className="italic">{node}</em>;
    if (m.bold) node = <strong className="font-semibold">{node}</strong>;
    return (
      <span key={idx} style={m.color ? { color: m.color } : undefined}>
        {node}
      </span>
    );
  });
}
