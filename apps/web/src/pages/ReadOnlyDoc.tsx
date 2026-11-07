import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { DocView } from "@/lib/api";
import { DiagramView } from "@/editor/DiagramView";
import { MathView } from "@/editor/MathView";
import { parseTableData } from "@/editor/model";
import { cn } from "@/lib/utils";

type Block = DocView["blocks"][number];
type Span = Block["spans"][number];

/** Never turn untrusted document data into a javascript: or data: link. */
function safeURL(url?: string): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("#/doc/")) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : undefined;
  } catch { return undefined; }
}

function fileURL(id?: string, publicToken?: string, versionSeq?: number): string | undefined {
  if (!id || !/^[1-9]\d*$/.test(id)) return undefined;
  if (publicToken) return `/api/public/${encodeURIComponent(publicToken)}/files/${id}`;
  const suffix = Number.isSafeInteger(versionSeq) && (versionSeq ?? 0) > 0 ? `?version=${versionSeq}` : "";
  return `/api/files/${id}${suffix}`;
}

function RichText({ spans }: { spans: Span[] }) {
  return <>{spans.map((span, i) => {
    const { text, marks } = span;
    if (marks.math) return <span key={i} className="mx-0.5 not-italic"><MathView src={marks.math} /></span>;
    const style: CSSProperties = { color: marks.color || undefined, background: marks.bg || undefined };
    if (marks.underline || marks.strike) style.textDecoration = [marks.underline && "underline", marks.strike && "line-through"].filter(Boolean).join(" ");
    const classes = cn(marks.bold && "font-semibold", marks.italic && "italic", marks.code && "rounded-[4px] bg-[#F2F3F5] px-1 py-px font-mono text-[0.88em] text-[#D83931]", marks.mention && "rounded bg-accent px-0.5 font-medium text-primary");
    const href = safeURL(marks.link);
    if (href) return <a key={i} href={href} target={href.startsWith("#/") ? undefined : "_blank"} rel={href.startsWith("#/") ? undefined : "noopener noreferrer"} className={cn(classes, "text-primary hover:underline")} style={style}>{text}</a>;
    return <span key={i} className={classes} style={style}>{text}</span>;
  })}</>;
}

function ReadOnlyImage({ block, publicToken, versionSeq, recovery }: { block: Block; publicToken?: string; versionSeq?: number; recovery?: number }) {
  const [failed, setFailed] = useState(false);
  const src = fileURL(block.props.fileId, publicToken, versionSeq);
  useEffect(() => { setFailed(false); }, [src, recovery]);
  if (!src || failed) return <div className="my-2 rounded-md border px-3 py-2 text-[13px] text-subtle" role="status">图片不可用或需要登录：{block.props.name || "图片"}</div>;
  return <figure className="my-2"><img src={src} alt={block.props.name || "图片"} referrerPolicy="no-referrer" className="max-h-[480px] max-w-full rounded-lg border" onError={() => setFailed(true)} /></figure>;
}

function ReadOnlyTable({ data }: { data?: string }) {
  const rows = parseTableData(data);
  return <div className="my-2 w-fit max-w-full overflow-x-auto rounded-lg border" data-table-block><table className="border-collapse text-[13px]"><tbody>{rows.map((row, ri) => <tr key={ri} className={ri > 0 && ri % 2 === 0 ? "bg-sidebar/40" : ""}>{Array.isArray(row) && row.map((cell, ci) => <td key={ci} className={cn("min-w-[90px] border px-2.5 py-1.5 align-top", ri === 0 && "bg-sidebar/70 font-medium")}>{typeof cell === "string" || typeof cell === "number" ? String(cell) : ""}</td>)}</tr>)}</tbody></table></div>;
}

function formatSize(size: string | undefined): string {
  const n = Number(size);
  if (!Number.isFinite(n) || n < 0) return "";
  return n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(0)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`;
}

function ReadOnlyVideo({ url, name }: { url?: string; name?: string }) {
  const [failed, setFailed] = useState(false);
  const href = safeURL(url);
  const native = !failed && href && /^https?:\/\//i.test(href) && /\.(mp4|webm|mov)(\?|$)/i.test(href);
  if (native) return <video src={href} controls onError={() => setFailed(true)} className="my-2 aspect-video w-full max-w-[640px] rounded-lg border bg-black" />;
  if (href) return <a href={href} target="_blank" rel="noopener noreferrer" className="my-2 block max-w-[640px] rounded-lg border px-3.5 py-3 text-primary">{name || href}</a>;
  return <div className="my-2 rounded-lg border px-3.5 py-3 text-subtle">视频链接不可用</div>;
}

const CALLOUT_BG = ["#F5F6F7", "#E1EAFF", "#D9F5D6", "#FEEAD2", "#FFF4C9", "#F8DEF8", "#FDEBE1"];

/** Renders a materialized snapshot using the same block representations as the editor. */
export function ReadOnlyDoc({ view, publicToken, disableFileDownloads = false, imageVersionSeq, imageRecovery }: { view: DocView; publicToken?: string; disableFileDownloads?: boolean; imageVersionSeq?: number; imageRecovery?: number }) {
  const children = new Map<string, Block[]>();
  for (const block of view.blocks) {
    const group = children.get(block.parent) ?? [];
    group.push(block);
    children.set(block.parent, group);
  }
  function renderChildren(parent: string): ReactNode {
    const blocks = (children.get(parent) ?? []).filter((b) => b.type !== "title");
    const counters: number[] = [];
    return blocks.map((block) => {
      const indent = Math.max(0, Math.min(20, Number(block.props.indent) || 0));
      let number = 0;
      if (block.type === "ordered") { counters.length = indent + 1; number = counters[indent] = (counters[indent] ?? 0) + 1; }
      else counters.length = 0;
      const text = block.spans.map((s) => s.text).join("");
      const rich = <RichText spans={block.spans} />;
      const nested = children.has(block.id) ? <div className="pl-6">{renderChildren(block.id)}</div> : null;
      let content: ReactNode;
      switch (block.type) {
        case "h1": content = <h1 className="mb-1 mt-5 text-[26px] font-semibold leading-[1.4]">{rich}</h1>; break;
        case "h2": content = <h2 className="mb-0.5 mt-4 text-[22px] font-semibold leading-[1.4]">{rich}</h2>; break;
        case "h3": content = <h3 className="mt-3 text-[18px] font-semibold leading-[1.5]">{rich}</h3>; break;
        case "h4": content = <h4 className="mt-3 text-[16px] font-semibold leading-[1.6]">{rich}</h4>; break;
        case "h5": content = <h5 className="mt-3 text-[15px] font-semibold leading-[1.6]">{rich}</h5>; break;
        case "h6": content = <h6 className="mt-3 text-[14px] font-semibold leading-[1.6] text-muted-foreground">{rich}</h6>; break;
        case "bullet": case "ordered": case "todo": content = <div className="flex gap-2 py-[2px] text-[16px] leading-[1.75]"><span className={cn("min-w-[18px] text-center", block.type !== "todo" && "text-primary")}>{block.type === "bullet" ? ["•", "◦", "▪"][indent % 3] : block.type === "ordered" ? `${number}.` : block.props.checked === "true" ? "☑" : "☐"}</span><span className={cn("min-w-0 flex-1 whitespace-pre-wrap break-words", block.type === "todo" && block.props.checked === "true" && "text-subtle line-through")}>{rich}</span></div>; break;
        case "quote": content = <blockquote className="my-1 border-l-[3px] border-border py-[2px] pl-3.5 text-[16px] leading-[1.75] text-muted-foreground">{rich}</blockquote>; break;
        case "code": content = <div className="my-2 overflow-hidden rounded-lg border border-[#e5e7eb] dark:border-[#3c4043]"><div className="border-b border-[#e5e7eb] bg-[#f7f8fa] px-3 py-1.5 text-[12px] text-muted-foreground dark:border-[#3c4043] dark:bg-[#23262a]">{block.props.lang || "plain"}</div><pre className="whitespace-pre-wrap break-words px-4 py-2.5 font-mono text-[13px] leading-6">{rich}</pre></div>; break;
        case "callout": content = <div className="my-1 flex gap-2 rounded-lg px-3.5 py-3" style={{ background: CALLOUT_BG[Number(block.props.color ?? 0)] ?? CALLOUT_BG[0] }}><span>{block.props.emoji || "💡"}</span><span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{rich}</span></div>; break;
        case "math": content = <div data-math className="my-2 overflow-x-auto rounded-lg px-3 py-2 text-[17px] italic leading-relaxed">{text ? <MathView src={text} /> : <span className="not-italic text-subtle">空公式</span>}</div>; break;
        case "diagram": content = <div data-diagram className="my-2 overflow-x-auto rounded-lg bg-surface py-3">{text ? <DiagramView src={text} /> : <span className="text-[13px] text-subtle">空流程图</span>}</div>; break;
        case "table": content = <ReadOnlyTable data={block.props.tableData} />; break;
        case "columns": content = <div data-columns className="my-2 rounded-lg border p-2"><div className="flex gap-2">{(children.get(block.id) ?? []).map((child) => <div key={child.id} className="min-w-0 flex-1 rounded-md bg-sidebar/40 p-2"><RichText spans={child.spans} />{renderChildren(child.id)}</div>)}</div></div>; break;
        case "divider": content = <hr className="my-3 border-border" />; break;
        case "image": content = <ReadOnlyImage key={`${block.id}:${block.props.fileId ?? ""}:${imageVersionSeq ?? ""}`} block={block} publicToken={publicToken} versionSeq={imageVersionSeq} recovery={imageRecovery} />; break;
        case "file": {
          const href = disableFileDownloads ? undefined : fileURL(block.props.fileId, publicToken);
          content = <div className="my-1 flex w-[360px] max-w-full items-center gap-3 rounded-lg border px-3.5 py-2.5"><span className="grid size-8 place-items-center rounded-md bg-[#FFF3E8] text-[10px] font-bold text-[#FF8800]">{(block.props.name?.split(".").pop() || "FILE").slice(0, 4).toUpperCase()}</span><span className="min-w-0">{href ? <a href={href} rel="noreferrer" className="block truncate text-[14px] font-medium hover:underline">{block.props.name || "附件"}</a> : <span className="block truncate text-[14px] font-medium">{block.props.name || "附件"}</span>}<span className="block text-[12px] text-subtle">{disableFileDownloads ? "下载已关闭" : formatSize(block.props.size)}</span></span></div>; break;
        }
        case "video": content = <ReadOnlyVideo url={block.props.url} name={block.props.name} />; break;
        case "bookmark": {
          const href = safeURL(block.props.url);
          content = <div className="my-2 flex max-w-[520px] items-center gap-3 rounded-lg border px-3.5 py-3"><span className="grid size-9 shrink-0 place-items-center rounded-md bg-accent text-[15px] font-semibold text-primary">{(block.props.name || "W").slice(0, 1).toUpperCase()}</span><span className="min-w-0 flex-1">{href ? <a href={href} target="_blank" rel="noopener noreferrer" className="block truncate text-[14px] font-medium">{block.props.name || href}</a> : <span className="block truncate text-[14px] font-medium">{block.props.name || "网页卡片"}</span>}<span className="block truncate text-[12px] text-subtle">{href || "链接不可用"}</span></span></div>; break;
        }
        default: content = <p className="whitespace-pre-wrap break-words py-[3px] text-[16px] leading-[1.75]">{rich}</p>;
      }
      return <div key={block.id} data-readonly-block={block.type} style={{ marginLeft: indent * 24 }}>{content}{block.type !== "columns" && nested}</div>;
    });
  }
  return <div data-readonly-doc>{renderChildren("0:0")}</div>;
}
