import { layoutMindTopics, mindDefaultTextColor, mindDescriptionAt, mindDescriptionLines, mindDescriptionStyleAt, mindDescriptionTextWidth, mindTitleHeight, type MindDescriptions, type MindDescriptionStyles, type MindPaint, type MindPaints, type MindStyles, type MindTextFormats, type MindTopic } from "./mindmap";
import type { MindDrop } from "./mindmap-move";

export function MindMapSvg({ topics, styles = {}, paints = {}, textFormats = {}, descriptions = {}, descriptionStyles = {}, collapsed = new Set(), selected, editing, descriptionEditing, dragPreview, onSelect, onContextMenu, onEdit, onDraft, onFinish, onCancel, onEditDescription, onDescriptionDraft, onDescriptionFinish, onDescriptionCancel, onFold, onAddChild }: {
  topics: readonly MindTopic[];
  styles?: MindStyles;
  paints?: MindPaints;
  textFormats?: MindTextFormats;
  descriptions?: MindDescriptions;
  descriptionStyles?: MindDescriptionStyles;
  collapsed?: ReadonlySet<string>;
  selected?: string | null;
  editing?: { id: string; value: string } | null;
  descriptionEditing?: { id: string; value: string } | null;
  dragPreview?: { id: string; x: number; y: number; drop: MindDrop | null } | null;
  onSelect?: (topic: MindTopic, event: React.PointerEvent<SVGGElement>) => void;
  onContextMenu?: (topic: MindTopic, event: React.MouseEvent<SVGGElement>) => void;
  onEdit?: (topic: MindTopic) => void;
  onDraft?: (value: string) => void;
  onFinish?: () => void;
  onCancel?: () => void;
  onEditDescription?: (topic: MindTopic) => void;
  onDescriptionDraft?: (value: string) => void;
  onDescriptionFinish?: () => void;
  onDescriptionCancel?: () => void;
  onFold?: (id: string) => void;
  onAddChild?: (id: string) => void;
}) {
  const displayDescriptions = descriptionEditing ? { ...descriptions, [descriptionEditing.id]: descriptionEditing.value || " " } : descriptions;
  const nodes = layoutMindTopics(topics, collapsed, styles, displayDescriptions, descriptionStyles), byId = new Map(nodes.map((node) => [node.topic.id, node]));
  const children = new Map<string, string[]>();
  for (const topic of topics) if (topic.parent) children.set(topic.parent, [...(children.get(topic.parent) ?? []), topic.id]);
  const descendants = (id: string): number => { const pending = [...(children.get(id) ?? [])], seen = new Set<string>(); while (pending.length) { const next = pending.pop()!; if (seen.has(next)) continue; seen.add(next); pending.push(...(children.get(next) ?? [])); } return seen.size; };
  const lineProps = (paint?: MindPaint) => ({ fill: "none", stroke: paint?.stroke ?? "#5b7ff1", strokeWidth: paint?.width ?? 2, strokeOpacity: (paint?.opacity ?? 100) / 100, strokeDasharray: paint?.line === "dashed" ? "6 4" : paint?.line === "dotted" ? "2 3" : undefined, pointerEvents: "none" as const });
  return <g data-mindmap>
    {nodes.map((node) => {
      const parent = node.topic.parent ? byId.get(node.topic.parent) : null;
      if (!parent) return null;
      const startX = parent.x + parent.w, startY = parent.y + parent.h / 2, endY = node.y + node.h / 2, mid = startX + 30;
      return <g key={`edge-${node.topic.id}`}><path d={`M${startX},${startY} H${mid} V${endY}`} {...lineProps(paints[parent.topic.id])}/><path data-mind-branch={node.topic.id} d={`M${mid},${endY} H${node.x}`} {...lineProps(paints[node.topic.id])}/></g>;
    })}
    {nodes.map((node) => {
      const root = node.topic.parent === null, active = selected === node.topic.id, isEditing = editing?.id === node.topic.id, isEditingDescription = descriptionEditing?.id === node.topic.id, description = mindDescriptionAt(descriptions, node.topic.id), descriptionStyle = mindDescriptionStyleAt(descriptionStyles, node.topic.id), descriptionSize = descriptionStyle?.size ?? 12, descriptionLineHeight = Math.ceil(descriptionSize * 1.35), descriptionLines = description ? mindDescriptionLines(description, descriptionSize) : [], style = styles[node.topic.id], paint = paints[node.topic.id], format = textFormats[node.topic.id], size = style?.size ?? (root ? 16 : 14), shape = style?.shape ?? (root ? "rect" : "text"), align = format?.align ?? (root || shape !== "text" ? "center" : "left"), titleHeight = mindTitleHeight(node.topic, styles), titleCenter = node.y + titleHeight / 2;
      const chars = [...node.topic.text], limit = Math.max(1, Math.floor((node.w - 32) / size)), label = chars.length > limit ? chars.slice(0, limit).join("") + "…" : node.topic.text;
      const textX = align === "center" ? node.x + node.w / 2 : align === "right" ? node.x + node.w - 8 : node.x + 8, anchor = align === "center" ? "middle" : align === "right" ? "end" : "start";
      const labelWidth = [...label].reduce((sum, ch) => sum + (/[\u2e80-\uffff]/.test(ch) ? size : size * 0.58), 0), highlightX = align === "center" ? textX - labelWidth / 2 : align === "right" ? textX - labelWidth : textX;
      const decoration = [format?.underline ? "underline" : "", format?.strike ? "line-through" : ""].filter(Boolean).join(" ");
      return <g key={node.topic.id} pointerEvents={onSelect ? undefined : "none"} data-mind-topic={node.topic.id} onPointerDown={onSelect ? (event) => { event.stopPropagation(); onSelect(node.topic, event); } : undefined} onContextMenu={onContextMenu ? (event) => { event.preventDefault(); event.stopPropagation(); onContextMenu(node.topic, event); } : undefined} onDoubleClick={onEdit ? (event) => { event.stopPropagation(); onEdit(node.topic); } : undefined} style={{ cursor: onSelect ? "pointer" : undefined }}>
        <title>{node.topic.text}</title>
        <rect x={node.x} y={node.y} width={node.w} height={node.h} rx={shape === "oval" ? node.h / 2 : shape === "rect" ? 6 : 0} fill={shape === "text" ? "transparent" : paint?.fill ?? (root ? "#5b7ff1" : "none")} fillOpacity={(paint?.fillOpacity ?? 100) / 100} stroke={shape !== "text" && (!root || paint?.stroke) ? paint?.stroke ?? "#5b7ff1" : "transparent"} strokeWidth={paint?.width ?? 2} strokeOpacity={(paint?.opacity ?? 100) / 100} strokeDasharray={paint?.line === "dashed" ? "6 4" : paint?.line === "dotted" ? "2 3" : undefined}/>
        <rect data-mind-outline x={node.x} y={node.y} width={node.w} height={node.h} fill="none" stroke={active ? "#3370ff" : "transparent"} strokeWidth={2}/>
        {!isEditing && !!label && format?.highlight && <rect x={highlightX - 2} y={titleCenter - size * 0.6} width={labelWidth + 4} height={size * 1.2} fill={format.highlight} pointerEvents="none"/>}
        {!isEditing && <text data-mind-placeholder={!node.topic.text ? "true" : undefined} x={textX} y={titleCenter} dominantBaseline="central" textAnchor={anchor} fill={node.topic.text ? style?.color ?? mindDefaultTextColor(root, shape, paint) : "#a3a8af"} fontSize={size} fontWeight={format?.bold ? 700 : undefined} fontStyle={format?.italic ? "italic" : undefined} textDecoration={decoration || undefined}>{label || (onSelect ? "输入文本" : "")}</text>}
        {isEditing && <foreignObject x={node.x} y={node.y} width={node.w} height={titleHeight}>
          <input autoFocus aria-label="思维导图节点文字" maxLength={500} value={editing.value} onPointerDown={(event) => event.stopPropagation()} onChange={(event) => onDraft?.(event.target.value)} onBlur={() => onFinish?.()} onKeyDown={(event) => { event.stopPropagation(); if (event.nativeEvent.isComposing) return; if (event.key === "Enter") { event.preventDefault(); onFinish?.(); } if (event.key === "Escape") { event.preventDefault(); onCancel?.(); } }} style={{ width: "100%", height: "100%", boxSizing: "border-box", border: "2px solid #3370ff", outline: "none", padding: "0 6px", borderRadius: 3, fontSize: size, fontWeight: format?.bold ? 700 : undefined, fontStyle: format?.italic ? "italic" : undefined, textDecoration: decoration || undefined, textAlign: align, color: style?.color ?? "#1f2329", background: format?.highlight ?? "#fff" }}/>
        </foreignObject>}
        {!isEditingDescription && descriptionStyle?.highlight && descriptionLines.map((line, index) => <rect key={`description-highlight-${index}`} x={node.x + 6} y={node.y + titleHeight + index * descriptionLineHeight} width={mindDescriptionTextWidth(line, descriptionSize) + 4} height={descriptionLineHeight} fill={descriptionStyle.highlight} pointerEvents="none"/>)}
        {!isEditingDescription && description && <text data-mind-description x={node.x + 8} y={node.y + titleHeight + descriptionSize} fontSize={descriptionSize} fill={descriptionStyle?.color ?? "#8f959e"} onDoubleClick={onEditDescription ? (event) => { event.stopPropagation(); onEditDescription(node.topic); } : undefined}>{descriptionLines.map((line, index) => <tspan key={index} x={node.x + 8} dy={index ? descriptionLineHeight : 0}>{line || "\u00a0"}</tspan>)}</text>}
        {isEditingDescription && <foreignObject x={node.x + 4} y={node.y + titleHeight} width={node.w - 8} height={node.h - titleHeight}>
          <textarea autoFocus aria-label="思维导图节点描述" maxLength={2000} value={descriptionEditing.value} onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onChange={(event) => onDescriptionDraft?.(event.target.value)} onBlur={() => onDescriptionFinish?.()} onKeyDown={(event) => { event.stopPropagation(); if (event.nativeEvent.isComposing) return; if (event.key === "Escape") { event.preventDefault(); onDescriptionCancel?.(); } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); onDescriptionFinish?.(); } }} placeholder="输入描述" style={{ width: "100%", height: "100%", boxSizing: "border-box", resize: "none", border: "1px solid #3370ff", outline: "none", padding: "2px 4px", fontSize: descriptionSize, lineHeight: `${descriptionLineHeight}px`, color: descriptionStyle?.color ?? "#646a73", background: descriptionStyle?.highlight ?? "#fff" }}/>
        </foreignObject>}
      </g>;
    })}
    {nodes.map((node) => {
      const count = descendants(node.topic.id), folded = collapsed.has(node.topic.id);
      if (!count || (!folded && (!onFold || (onSelect && selected !== node.topic.id)))) return null;
      const x = node.x + node.w + 10, y = node.y + node.h / 2;
      return <g key={`fold-${node.topic.id}`} data-mind-fold={node.topic.id} data-mind-fold-expanded={!folded ? "true" : undefined} role={onFold ? "button" : undefined} tabIndex={onFold ? 0 : undefined} aria-label={onFold ? `${folded ? "展开" : "折叠"}「${node.topic.text || "节点"}」` : undefined} aria-expanded={onFold ? !folded : undefined} pointerEvents={onFold ? undefined : "none"} style={{ cursor: onFold ? "pointer" : undefined }} onPointerDown={onFold ? (event) => event.stopPropagation() : undefined} onClick={onFold ? (event) => { event.stopPropagation(); onFold(node.topic.id); } : undefined} onKeyDown={onFold ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); onFold(node.topic.id); } } : undefined}>
        <circle cx={x} cy={y} r={folded && count > 9 ? 10 : 8} fill="#fff" stroke="#3370ff"/>
        <text x={x} y={y} textAnchor="middle" dominantBaseline="central" fontSize={folded ? 10 : 16} fill="#3370ff">{folded ? count > 99 ? "99+" : count : "‹"}</text>
      </g>;
    })}
    {onAddChild && !editing && !descriptionEditing && nodes.filter((node) => node.topic.id === selected).map((node) => {
      const x = node.x + node.w + (descendants(node.topic.id) ? 38 : 18), y = node.y + node.h / 2;
      return <g key={`add-${node.topic.id}`} data-mind-add={node.topic.id} role="button" tabIndex={0} aria-label={`为「${node.topic.text || "节点"}」添加子节点`} style={{ cursor: "pointer" }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onAddChild(node.topic.id); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); onAddChild(node.topic.id); } }}>
        <circle cx={x} cy={y} r={10} fill="#3370ff"/><path d={`M${x - 4},${y}h8 M${x},${y - 4}v8`} fill="none" stroke="#fff" strokeWidth={1.5} strokeLinecap="round" pointerEvents="none"/>
      </g>;
    })}
    {dragPreview && (() => {
      const source = byId.get(dragPreview.id), target = dragPreview.drop ? byId.get(dragPreview.drop.target) : undefined;
      if (!source) return null;
      const y = target && dragPreview.drop?.kind === "before" ? target.y - 5 : target ? target.y + target.h + 5 : 0;
      return <g data-mind-drag-preview pointerEvents="none">
        {target && (dragPreview.drop?.kind === "child" ? <rect x={target.x - 4} y={target.y - 4} width={target.w + 8} height={target.h + 8} rx={5} fill="#3370ff" fillOpacity={0.08} stroke="#3370ff" strokeWidth={2}/> : <path d={`M${target.x - 5},${y} H${target.x + target.w + 5}`} stroke="#3370ff" strokeWidth={3}/>)}
        <rect x={dragPreview.x - source.w / 2} y={dragPreview.y - source.h / 2} width={source.w} height={source.h} rx={4} fill="#fff" fillOpacity={0.9} stroke="#3370ff" strokeDasharray="4 3"/>
        <text x={dragPreview.x} y={dragPreview.y} textAnchor="middle" dominantBaseline="central" fontSize={14} fill="#1f2329">{source.topic.text || "输入文本"}</text>
      </g>;
    })()}
  </g>;
}
