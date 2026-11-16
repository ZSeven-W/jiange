import { FlowSvg } from "@/editor/flowchart/flowchart-block";
import { readFlow } from "@/editor/flowchart/model";
import { tableCellAlign, tableCellFill, tableDataOf } from "@/editor/table-cells";
import { calloutStyle } from "@/editor/block-styles";
import { codeLangLabel } from "@/editor/code-block-header";
import { imageAlign } from "@/editor/image-block";
import { FileCard } from "@/editor/file-card";
import { coverMap, parseMerges } from "@/editor/table-ops";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Comment, DocView } from "@/lib/api";
import { parseKey, type Doc } from "@jiange/collab";
import { projectCommentAnchors } from "@/editor/comment-anchor";
import { DiagramView } from "@/editor/diagram-view";
import { MathView } from "@/editor/math-view";
import { mathSpansFromChars, parseTableData } from "@/editor/model";
import { cn } from "@/lib/utils";
import { safeURL } from "@/lib/safe-url";
import { BlockHandle } from "@/editor/block-handle";
import { columnWeights, COLUMN_WIDTHS } from "@/editor/column-widths";
import { useTableStickyHeader } from "@/editor/table-sticky-header";
import { parseTableWidths, visibleTableWidths } from "@/editor/table-widths";

type Block = DocView["blocks"][number];
type Span = Block["spans"][number];

function fileURL(id?: string, publicToken?: string, versionSeq?: number): string | undefined {
  if (!id || !/^[1-9]\d*$/.test(id)) return undefined;
  if (publicToken) return `/api/public/${encodeURIComponent(publicToken)}/files/${id}`;
  const suffix = Number.isSafeInteger(versionSeq) && (versionSeq ?? 0) > 0 ? `?version=${versionSeq}` : "";
  return `/api/files/${id}${suffix}`;
}

function RichText({ spans, flags, activeThread, onActivateComment }: { spans: Span[]; flags?: (number | null)[]; activeThread?: number | null; onActivateComment?: (id: number) => void }) {
  // A formula can be split into multiple view spans by unrelated formatting.
  // Rebuild the same atomic boundaries as the editor before rendering it.
  const chars = spans.flatMap((span, source) => [...span.text].map((ch) => ({ ch, marks: span.marks, source })));
  const atoms = new Map(mathSpansFromChars(chars).map((atom) => [atom.start, atom]));
  const runs: (Span & { anchor: number | null })[] = [];
  for (let i = 0; i < chars.length;) {
    const atom = atoms.get(i);
    if (atom) {
      const covered = (flags ?? []).slice(i, atom.end).filter((id): id is number => id != null);
      runs.push({ text: chars.slice(i, atom.end).map((char) => char.ch).join(""), marks: chars[i].marks, anchor: activeThread != null && covered.includes(activeThread) ? activeThread : covered[0] ?? null });
      i = atom.end;
    } else {
      let end = i + 1;
      while (end < chars.length && !atoms.has(end) && chars[end].source === chars[i].source && (flags?.[end] ?? null) === (flags?.[i] ?? null)) end++;
      runs.push({ text: chars.slice(i, end).map((char) => char.ch).join(""), marks: chars[i].marks, anchor: flags?.[i] ?? null });
      i = end;
    }
  }
  return <>{runs.map((span, i) => {
    const { text, marks } = span;
    const wrap = (content: ReactNode) => span.anchor == null ? <span key={i}>{content}</span> : <span key={i} role="button" tabIndex={0} data-comment-anchor={span.anchor} className={cn("cursor-pointer border-b-2 border-[#F5B1E5] focus-visible:outline-2 focus-visible:outline-primary", activeThread === span.anchor ? "bg-[#FBDC8D]" : "bg-[#FFF3D6]")} onClick={(event) => { if (!(event.target instanceof Element) || !event.target.closest("a")) onActivateComment?.(span.anchor!); }} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onActivateComment?.(span.anchor!); } }}>{content}</span>;
    if (marks.math) return wrap(<span className="mx-0.5 not-italic"><MathView src={marks.math} /></span>);
    const style: CSSProperties = { color: marks.color || undefined, background: marks.bg || undefined };
    if (marks.underline || marks.strike) style.textDecoration = [marks.underline && "underline", marks.strike && "line-through"].filter(Boolean).join(" ");
    const classes = cn(marks.bold && "font-semibold", marks.italic && "italic", marks.code && "rounded-[4px] bg-[#F2F3F5] px-1 py-px font-mono text-[0.88em] text-[#D83931]", marks.mention && "rounded bg-accent px-0.5 font-medium text-primary");
    const href = safeURL(marks.link);
    if (href) return wrap(<a href={href} target={href.startsWith("#/") ? undefined : "_blank"} rel={href.startsWith("#/") ? undefined : "noopener noreferrer"} className={cn(classes, "text-primary hover:underline")} style={style}>{text}</a>);
    return wrap(<span className={classes} style={style}>{text}</span>);
  })}</>;
}

function ReadOnlyImage({ block, publicToken, versionSeq, recovery, disableFileDownloads = false, onPreview, activeComment = false }: { block: Block; publicToken?: string; versionSeq?: number; recovery?: number; disableFileDownloads?: boolean; onPreview?: (src: string, name: string, mime?: string) => void; activeComment?: boolean }) {
  const [failed, setFailed] = useState(false);
  const src = fileURL(block.props.fileId, publicToken, versionSeq);
  useEffect(() => { setFailed(false); }, [src, recovery]);
  if (!src || failed) return <div className="my-2 rounded-md border px-3 py-2 text-[13px] text-subtle" role="status">图片不可用或需要登录：{block.props.name || "图片"}</div>;
  const align = imageAlign(block.props.align);
  const width = Number(block.props.imageWidth) || undefined;
  const name = block.props.caption || block.props.name || "图片";
  const widthStyle = width ? { width: `${Math.min(100, width)}%` } : undefined;
  const image = <img src={src} alt={name} referrerPolicy="no-referrer" draggable={!disableFileDownloads} onContextMenu={(event) => { if (disableFileDownloads) event.preventDefault(); }} style={onPreview && width ? { width: "100%" } : widthStyle} className={cn("max-h-[640px] max-w-full rounded-[4px] object-contain", activeComment && "outline outline-2 outline-offset-2 outline-[#F0B400]")} onError={() => setFailed(true)} />;
  return <figure className={cn("my-2 flex flex-col", align === "center" ? "items-center" : align === "right" ? "items-end" : "items-start")} data-image-align={align}>{onPreview ? <button type="button" aria-label={`查看图片：${name}`} onClick={() => onPreview(src, name, block.props.mime?.startsWith("image/") ? block.props.mime : "image/*")} style={widthStyle} className="max-w-full cursor-zoom-in rounded-[4px] focus-visible:outline-2 focus-visible:outline-primary">{image}</button> : image}{block.props.caption && <figcaption className="mt-1.5 text-center text-[14px] text-muted-foreground">{block.props.caption}</figcaption>}</figure>;
}

function ReadOnlyTable({ data, merges, widths, fillProps = {}, header = true, headerColumn = false, activeComment = false }: { data?: string; merges?: string; widths?: string; fillProps?: Record<string, string>; header?: boolean; headerColumn?: boolean; activeComment?: boolean }) {
  const rows = parseTableData(data);
  const columnWidths = visibleTableWidths(rows, parseTableWidths(widths));
  const cover = coverMap(parseMerges(merges, rows.length, rows[0]?.length ?? 0));
  const root = useRef<HTMLDivElement>(null);
  useTableStickyHeader(root, header);
  return <div ref={root} className={cn("my-2 w-fit max-w-full overflow-x-auto", activeComment && "rounded-[2px] outline outline-2 outline-offset-2 outline-[#F0B400]")} data-table-block><table className="table-fixed border-collapse text-[14px] leading-[1.6]" style={{ width: columnWidths.reduce((total, width) => total + width, 0) }}><colgroup>{columnWidths.map((width, ci) => <col key={ci} style={{ width }} />)}</colgroup><tbody>{rows.map((row, ri) => <tr key={ri} data-table-title-row={ri === 0 ? "true" : undefined}>{Array.isArray(row) && row.map((cell, ci) => {
    const cov = cover.get(`${ri}:${ci}`);
    if (cov === "hidden") return null;
    return <td key={ci} rowSpan={cov?.span[0]} colSpan={cov?.span[1]} className={cn("h-[38px] min-w-[90px] whitespace-pre-wrap break-words border border-[#DEE0E3] px-2.5 py-[7px] align-top dark:border-border", (header && ri === 0 || headerColumn && ci === 0) && "bg-[#F5F6F7] font-medium dark:bg-sidebar")} style={{ backgroundColor: tableCellFill(fillProps, ri, ci) || undefined, textAlign: tableCellAlign(fillProps, ri, ci, "horizontal"), verticalAlign: tableCellAlign(fillProps, ri, ci, "vertical") }}>{typeof cell === "string" || typeof cell === "number" ? String(cell) : ""}</td>;
  })}</tr>)}</tbody></table></div>;
}

function formatSize(size: string | undefined): string {
  const n = Number(size);
  if (!Number.isFinite(n) || n < 0) return "";
  return n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(0)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`;
}

function ReadOnlyVideo({ url, name, disableFileDownloads = false }: { url?: string; name?: string; disableFileDownloads?: boolean }) {
  const [failed, setFailed] = useState(false);
  const href = safeURL(url);
  const native = !failed && href && /^https?:\/\//i.test(href) && /\.(mp4|webm|mov)(\?|$)/i.test(href);
  if (native) return <video src={href} controls controlsList={disableFileDownloads ? "nodownload" : undefined} onContextMenu={(event) => { if (disableFileDownloads) event.preventDefault(); }} onError={() => setFailed(true)} className="my-2 aspect-video w-full max-w-[640px] rounded-lg border bg-black" />;
  if (href && !disableFileDownloads) return <a href={href} target="_blank" rel="noopener noreferrer" className="my-2 block max-w-[640px] rounded-lg border px-3.5 py-3 text-primary">{name || href}</a>;
  if (href) return <div className="my-2 rounded-lg border px-3.5 py-3 text-subtle">{name || "视频"} · 当前不提供外部链接</div>;
  return <div className="my-2 rounded-lg border px-3.5 py-3 text-subtle">视频链接不可用</div>;
}


/** Renders a materialized snapshot using the same block representations as the editor. */
export function ReadOnlyDoc({ view, publicToken, disableFileDownloads = false, imageVersionSeq, imageRecovery, onPreviewImage, commentDoc, comments = [], activeThread = null, onActivateComment, onCopyBlockLink }: { view: DocView; publicToken?: string; disableFileDownloads?: boolean; imageVersionSeq?: number; imageRecovery?: number; onPreviewImage?: (src: string, name: string, mime?: string) => void; commentDoc?: Doc; comments?: readonly Comment[]; activeThread?: number | null; onActivateComment?: (id: number) => void; onCopyBlockLink?: (blockId: string) => void }) {
  const [menuBlock, setMenuBlock] = useState<string | null>(null);
  const [touchBlock, setTouchBlock] = useState<string | null>(null);
  const actions = (block: Block) => onCopyBlockLink && <span className={cn("pointer-events-none absolute -left-10 top-0 z-20 flex items-center opacity-0 group-hover/public-block:pointer-events-auto group-hover/public-block:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 sm:-left-14 [&_[data-block-handle]]:gap-0.5 [&_[data-block-handle]]:px-1", (menuBlock === block.id || touchBlock === block.id) && "pointer-events-auto opacity-100")}><BlockHandle type={block.type} open={menuBlock === block.id} onOpenChange={(open) => setMenuBlock(open ? block.id : null)} can={{ link: true }} onAction={(action) => { if (action.kind === "link") onCopyBlockLink(block.id); }}/></span>;
  const touch = (event: React.PointerEvent<HTMLDivElement>, id: string) => { if (event.pointerType === "touch" && event.target instanceof Element && event.target.closest("[data-public-block]")?.getAttribute("data-public-block") === id && !event.target.closest("a,button,input,textarea,video")) setTouchBlock(id); };
  const children = new Map<string, Block[]>();
  for (const block of view.blocks) {
    const group = children.get(block.parent) ?? [];
    group.push(block);
    children.set(block.parent, group);
  }
  const projection = (block: Block) => commentDoc && onActivateComment ? projectCommentAnchors(commentDoc, parseKey(block.id), comments, activeThread) : undefined;
  const richText = (block: Block) => <RichText spans={block.spans} flags={projection(block)?.flags} activeThread={activeThread} onActivateComment={onActivateComment} />;
  function renderChildren(parent: string): ReactNode {
    const blocks = (children.get(parent) ?? []).filter((b) => b.type !== "title");
    const counters: number[] = [];
    return blocks.map((block) => {
      const indent = Math.max(0, Math.min(20, Number(block.props.indent) || 0));
      let number = 0;
      if (block.type === "ordered") { counters.length = indent + 1; number = counters[indent] = (counters[indent] ?? 0) + 1; }
      else counters.length = 0;
      const text = block.spans.map((s) => s.text).join("");
      const anchors = projection(block);
      const activeBlockComment = !!anchors?.blockThreadIds.includes(activeThread ?? -1);
      const rich = <RichText spans={block.spans} flags={anchors?.flags} activeThread={activeThread} onActivateComment={onActivateComment} />;
      const nested = children.has(block.id) ? <div className="pl-6">{renderChildren(block.id)}</div> : null;
      let content: ReactNode;
      switch (block.type) {
        case "h1": content = <h1 className="mb-1 mt-5 text-[26px] font-medium leading-[1.4]">{rich}</h1>; break;
        case "h2": content = <h2 className="mb-0.5 mt-4 text-[22px] font-medium leading-[1.4]">{rich}</h2>; break;
        case "h3": content = <h3 className="mt-3.5 text-[20px] font-medium leading-[1.45]">{rich}</h3>; break;
        case "h4": content = <h4 className="mt-3 text-[18px] font-medium leading-[1.5]">{rich}</h4>; break;
        case "h5": content = <h5 className="mt-2.5 text-[16px] font-medium leading-[1.6]">{rich}</h5>; break;
        case "h6": content = <h6 className="mt-2.5 text-[16px] font-medium leading-[1.6]">{rich}</h6>; break;
        case "bullet": case "ordered": case "todo": content = <div className="flex gap-2 py-[3px] text-[16px] leading-[1.75]"><span className={cn("min-w-[18px] text-center", block.type !== "todo" && "text-primary")}>{block.type === "bullet" ? ["•", "◦", "▪"][indent % 3] : block.type === "ordered" ? `${number}.` : block.props.checked === "true" ? "☑" : "☐"}</span><span className={cn("min-w-0 flex-1 whitespace-pre-wrap break-words", block.type === "todo" && block.props.checked === "true" && "text-subtle line-through")}>{rich}</span></div>; break;
        case "quote": content = <blockquote className="my-1 border-l-2 border-[#BBBFC4] py-[3px] pl-3 dark:border-border text-[16px] leading-[1.75] text-muted-foreground">{rich}</blockquote>; break;
        case "code": content = <div className="my-2 rounded-md bg-[#F5F6F7] dark:bg-[#23262a]"><div className="px-3.5 pt-2 text-[12px] text-subtle">{codeLangLabel(block.props.lang)}</div><pre className={cn("px-4 pb-3 pt-0.5 font-mono text-[14px] leading-[1.6]", block.props.wrap === "false" ? "overflow-x-auto whitespace-pre" : "whitespace-pre-wrap break-words")}>{rich}</pre></div>; break;
        case "callout": content = <div className="my-1 flex gap-2 rounded-lg border px-3.5 py-[15px]" style={calloutStyle(block.props.color)}><span>{block.props.emoji || "💡"}</span><span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{rich}</span></div>; break;
        case "math": content = <div data-math className="my-2 overflow-x-auto rounded-lg px-3 py-3 text-center text-[17px] italic leading-relaxed">{text ? <MathView src={text} /> : <span className="not-italic text-subtle">空公式</span>}</div>; break;
        case "diagram": content = <div data-diagram className="my-2 overflow-x-auto rounded-lg bg-surface py-3">{text ? <DiagramView src={text} /> : <span className="text-[13px] text-subtle">空流程图</span>}</div>; break;
        case "flowchart": { const g = readFlow(block.props); content = <div data-flowchart className="my-2 overflow-hidden rounded-lg border border-[#DEE0E3] dark:border-border" style={{ height: Math.min(1200, Math.max(200, Number(block.props["fc.h"]) || 360)) }}>{g.nodes.length ? <FlowSvg graph={g} width="100%" height="100%" idPrefix={`ro${block.id.replace(/\W/g, "")}`} fileUrl={(fid) => fileURL(String(fid), publicToken, imageVersionSeq) ?? ""} /> : <span className="grid h-full place-items-center text-[13px] text-subtle">空白流程图</span>}</div>; break; }
        case "table": content = <ReadOnlyTable data={tableDataOf(block.props)} merges={block.props.tableMerges} widths={block.props.tableWidths} fillProps={block.props} header={block.props.tableHeader !== "none"} headerColumn={block.props.tableHeaderColumn === "column"} activeComment={activeBlockComment} />; break;
        case "columns": {
          const columns = children.get(block.id) ?? [], weights = columnWeights(block.props[COLUMN_WIDTHS], columns.map((child) => child.id));
          content = <div data-columns className="my-2 overflow-x-auto" data-column-scroll><div className="flex w-full gap-8">{columns.map((child, index) => <div key={child.id} data-public-block={onCopyBlockLink ? child.id : undefined} onPointerDown={(event) => touch(event, child.id)} className={cn("min-w-[132px] flex-1 whitespace-pre-wrap break-words sm:min-w-0", onCopyBlockLink && "group/public-block relative")} style={{ flexGrow: weights[index], flexBasis: "0%", textAlign: child.props.align === "center" || child.props.align === "right" ? child.props.align : "left" }}>{actions(child)}{richText(child)}{renderChildren(child.id)}</div>)}</div></div>;
          break;
        }
        case "divider": content = <hr className="my-5 h-px border-0 bg-[#DEE0E3] dark:bg-border" data-divider />; break;
        case "image": content = <ReadOnlyImage key={`${block.id}:${block.props.fileId ?? ""}:${imageVersionSeq ?? ""}`} block={block} publicToken={publicToken} versionSeq={imageVersionSeq} recovery={imageRecovery} disableFileDownloads={disableFileDownloads} onPreview={onPreviewImage} activeComment={activeBlockComment} />; break;
        case "file": {
          const href = disableFileDownloads ? undefined : fileURL(block.props.fileId, publicToken, imageVersionSeq);
          content = <FileCard fileId={block.props.fileId} name={block.props.name} size={block.props.size} canDownload={!!href} href={href} />; break;
        }
        case "video": content = <ReadOnlyVideo url={block.props.url} name={block.props.name} disableFileDownloads={disableFileDownloads} />; break;
        case "bookmark": {
          const href = safeURL(block.props.url);
          content = <div className="my-2 flex max-w-[520px] items-center gap-3 rounded-lg border px-3.5 py-3"><span className="grid size-9 shrink-0 place-items-center rounded-md bg-accent text-[15px] font-semibold text-primary">{(block.props.name || "W").slice(0, 1).toUpperCase()}</span><span className="min-w-0 flex-1">{href ? <a href={href} target="_blank" rel="noopener noreferrer" className="block truncate text-[14px] font-medium">{block.props.title || block.props.name || href}</a> : <span className="block truncate text-[14px] font-medium">{block.props.title || block.props.name || "网页卡片"}</span>}<span className="block truncate text-[12px] text-subtle">{href || "链接不可用"}</span></span></div>; break;
        }
        default: content = <p className="whitespace-pre-wrap break-words py-[3px] text-[16px] leading-[1.75]">{rich}</p>;
      }
      return <div key={block.id} data-readonly-block={block.type} data-public-block={onCopyBlockLink ? block.id : undefined} data-comment-block={anchors?.blockThreadIds.join(" ") || undefined} onPointerDown={(event) => touch(event, block.id)} className={cn(onCopyBlockLink && "group/public-block relative", activeBlockComment && block.type !== "image" && block.type !== "table" && "rounded-[6px] outline outline-2 outline-offset-2 outline-[#F0B400]")} style={{ marginLeft: indent * 24, textAlign: block.props.align === "center" || block.props.align === "right" ? block.props.align : undefined }}>{actions(block)}{content}{!!anchors?.blockThreadIds.length && <button type="button" className="my-1 rounded-full border border-[#f5b1e5] bg-surface px-2 py-0.5 text-[11px] text-[#c950a8]" onClick={() => onActivateComment?.(anchors.blockThreadIds.includes(activeThread ?? -1) ? activeThread! : anchors.blockThreadIds[0])}>{anchors.blockThreadIds.length} 条评论</button>}{block.type !== "columns" && nested}</div>;
    });
  }
  return <div data-readonly-doc>{renderChildren("0:0")}</div>;
}
