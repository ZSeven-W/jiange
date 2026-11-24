import { mindDefaultTextColor, mindDescriptionAt, mindDescriptionLines, mindDescriptionStyleAt, mindDescriptionTextWidth, mindTitleHeight, type MindDescriptions, type MindDescriptionStyles, type MindPaint, type MindPaints, type MindStyles, type MindTextFormats, type MindTopic, type PositionedTopic } from "./mindmap";
import { layoutMindTopicsWithStructure, mindRelationCurvePath, mindRelationLabelPoint, type MindLayoutKind, type MindRelation } from "./mindmap-layouts";
import type { MindDrop } from "./mindmap-move";
import { computeBoundaryBox, computeSummaryBrace, priorityBadgeMeta, progressWedgePath, type MindBadges, type MindBoundaries, type MindSummaries } from "./whiteboard-extras";
import { useI18n } from "@/lib/i18n";

function pillTextWidth(text: string, fontSize = 11): number {
  return [...text].reduce((sum, ch) => sum + (/[\u2e80-\uffff]/.test(ch) ? fontSize : fontSize * 0.6), 0);
}

export function MindMapSvg({ topics, structure = "logic", relations = [], relationFromId = null, onRemoveRelation, boundaries = {}, summaries = {}, badges = {}, onEditBoundary, onEditSummary, styles = {}, paints = {}, textFormats = {}, descriptions = {}, descriptionStyles = {}, collapsed = new Set(), selected, editing, descriptionEditing, dragPreview, gpuBacked = false, onSelect, onContextMenu, onEdit, onDraft, onFinish, onCancel, onEditDescription, onDescriptionDraft, onDescriptionFinish, onDescriptionCancel, onFold, onAddChild }: {
  topics: readonly MindTopic[];
  structure?: MindLayoutKind;
  relations?: readonly MindRelation[];
  relationFromId?: string | null;
  onRemoveRelation?: (id: string) => void;
  boundaries?: MindBoundaries;
  summaries?: MindSummaries;
  badges?: MindBadges;
  onEditBoundary?: (nodeId: string) => void;
  onEditSummary?: (parentId: string) => void;
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
  gpuBacked?: boolean;
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
  const { t } = useI18n();
  const displayDescriptions = descriptionEditing ? { ...descriptions, [descriptionEditing.id]: descriptionEditing.value || " " } : descriptions;
  const nodes = layoutMindTopicsWithStructure(topics, structure, collapsed, styles, displayDescriptions, descriptionStyles), byId = new Map(nodes.map((node) => [node.topic.id, node]));
  const topicById = new Map(topics.map((topic) => [topic.id, topic]));
  const children = new Map<string, string[]>();
  for (const topic of topics) if (topic.parent) children.set(topic.parent, [...(children.get(topic.parent) ?? []), topic.id]);
  const descendants = (id: string): number => { const pending = [...(children.get(id) ?? [])], seen = new Set<string>(); while (pending.length) { const next = pending.pop()!; if (seen.has(next)) continue; seen.add(next); pending.push(...(children.get(next) ?? [])); } return seen.size; };
  const topBranchOf = (id: string): { root: PositionedTopic; branch: PositionedTopic } | null => {
    let cur = topicById.get(id), branchId = id, guard = 0;
    while (cur && cur.parent !== null && guard++ < 34) {
      const parent = topicById.get(cur.parent);
      if (!parent) return null;
      if (parent.parent === null) {
        const rootPos = byId.get(parent.id), branchPos = byId.get(branchId);
        return rootPos && branchPos ? { root: rootPos, branch: branchPos } : null;
      }
      branchId = parent.id;
      cur = parent;
    }
    return null;
  };
  const fishboneAttachX = (rootPos: PositionedTopic, branchPos: PositionedTopic): number => {
    const spineY = rootPos.y + rootPos.h / 2;
    const above = branchPos.y + branchPos.h / 2 < spineY;
    const tipY = above ? branchPos.y + branchPos.h : branchPos.y;
    return Math.round(branchPos.x + branchPos.w / 2 + Math.abs(spineY - tipY) * 0.36);
  };
  const lineProps = (paint?: MindPaint) => ({ fill: "none", stroke: gpuBacked ? "transparent" : paint?.stroke ?? "#5b7ff1", strokeWidth: paint?.width ?? 2, strokeOpacity: (paint?.opacity ?? 100) / 100, strokeDasharray: paint?.line === "dashed" ? "6 4" : paint?.line === "dotted" ? "2 3" : undefined, pointerEvents: "none" as const });
  const visibleRelations = relations.filter((rel) => byId.has(rel.fromId) && byId.has(rel.toId));
  const renderedBoundaries = Object.entries(boundaries)
    .map(([nodeId, boundary]) => {
      const box = computeBoundaryBox(nodeId, topics, nodes);
      return box ? { nodeId, boundary, box } : null;
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
  const renderedSummaries = Object.entries(summaries)
    .map(([parentId, summary]) => {
      const brace = computeSummaryBrace(parentId, topics, nodes, structure, summary.label);
      return brace ? { parentId, summary, brace } : null;
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
  return <g data-mindmap data-mind-structure={structure}>
    {visibleRelations.length > 0 && (
      <defs>
        <marker id="mind-rel-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto">
          <path d="M0,1 L9,5 L0,9 z" fill="#7b56d9" />
        </marker>
      </defs>
    )}
    {renderedBoundaries.map(({ nodeId, boundary, box }) => {
      const labelW = boundary.label ? Math.max(36, Math.round(pillTextWidth(boundary.label, 11) + 16)) : 0;
      return (
        <g key={`boundary-${nodeId}`} data-mind-boundary={nodeId}>
          <rect
            x={box.x}
            y={box.y}
            width={box.w}
            height={box.h}
            rx={12}
            fill={boundary.color}
            fillOpacity={0.07}
            stroke={boundary.color}
            strokeWidth={1.6}
            strokeDasharray="6 4"
            pointerEvents="none"
          />
          {boundary.label && (
            <g
              data-mind-boundary-label={nodeId}
              style={{ cursor: onEditBoundary ? "pointer" : undefined }}
              onPointerDown={onEditBoundary ? (e) => e.stopPropagation() : undefined}
              onDoubleClick={onEditBoundary ? (e) => { e.stopPropagation(); onEditBoundary(nodeId); } : undefined}
            >
              <rect
                x={box.x + 10}
                y={box.y - 10}
                width={labelW}
                height={20}
                rx={10}
                fill="#ffffff"
                stroke={boundary.color}
                strokeWidth={1.2}
              />
              <text
                x={box.x + 10 + labelW / 2}
                y={box.y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={11}
                fontWeight={500}
                fill={boundary.color}
                pointerEvents="none"
              >
                {boundary.label}
              </text>
            </g>
          )}
        </g>
      );
    })}
    {structure === "fishbone" && nodes.filter((node) => node.topic.parent === null).map((rootPos) => {
      const branches = nodes.filter((n) => n.topic.parent === rootPos.topic.id);
      if (!branches.length) return null;
      const spineY = rootPos.y + rootPos.h / 2;
      const tailX = Math.min(...branches.map((b) => fishboneAttachX(rootPos, b))) - 28;
      return <line key={`fish-spine-${rootPos.topic.id}`} data-mind-fishbone-spine={rootPos.topic.id} x1={tailX} y1={spineY} x2={rootPos.x} y2={spineY} stroke={paints[rootPos.topic.id]?.stroke ?? "#5b7ff1"} strokeWidth={2.5} strokeLinecap="round" pointerEvents="none"/>;
    })}
    {structure === "timeline" && nodes.filter((node) => node.topic.parent === null).map((rootPos) => {
      const milestones = nodes.filter((n) => n.topic.parent === rootPos.topic.id);
      if (!milestones.length) return null;
      const axisY = rootPos.y + rootPos.h / 2;
      const endX = Math.max(...milestones.map((m) => m.x + m.w / 2)) + 24;
      return <g key={`tl-spine-${rootPos.topic.id}`} data-mind-timeline-spine={rootPos.topic.id} pointerEvents="none">
        <line x1={rootPos.x + rootPos.w} y1={axisY} x2={endX} y2={axisY} stroke={paints[rootPos.topic.id]?.stroke ?? "#5b7ff1"} strokeWidth={2.5} strokeLinecap="round"/>
        {milestones.map((m) => <circle key={`tl-dot-${m.topic.id}`} cx={m.x + m.w / 2} cy={axisY} r={4.5} fill={paints[m.topic.id]?.stroke ?? "#3370ff"} stroke="#ffffff" strokeWidth={1.5}/>)}
      </g>;
    })}
    {nodes.map((node) => {
      const parent = node.topic.parent ? byId.get(node.topic.parent) : null;
      if (!parent) return null;
      if (structure === "org") {
        const px = parent.x + parent.w / 2, py = parent.y + parent.h, cx = node.x + node.w / 2, midY = (py + node.y) / 2;
        return <g key={`edge-${node.topic.id}`}>
          <path d={`M${px},${py} V${midY} H${cx}`} {...lineProps(paints[parent.topic.id])}/>
          <path data-mind-branch={node.topic.id} d={`M${cx},${midY} V${node.y}`} {...lineProps(paints[node.topic.id])}/>
        </g>;
      }
      if (structure === "fishbone") {
        if (parent.topic.parent === null) {
          const spineY = parent.y + parent.h / 2;
          const above = node.y + node.h / 2 < spineY;
          const tipY = above ? node.y + node.h : node.y;
          const tipX = node.x + node.w / 2;
          const attachX = fishboneAttachX(parent, node);
          return <g key={`edge-${node.topic.id}`}>
            <path data-mind-branch={node.topic.id} d={`M${attachX},${spineY} L${tipX},${tipY}`} {...lineProps(paints[node.topic.id] ?? paints[parent.topic.id])}/>
          </g>;
        }
        const ctx = topBranchOf(node.topic.id);
        const cy = node.y + node.h / 2;
        if (ctx) {
          const spineY = ctx.root.y + ctx.root.h / 2;
          const attachX = fishboneAttachX(ctx.root, ctx.branch);
          const ribX = Math.round(attachX - Math.abs(cy - spineY) * 0.36);
          return <g key={`edge-${node.topic.id}`}>
            <path data-mind-branch={node.topic.id} d={`M${ribX},${cy} H${node.x + node.w}`} {...lineProps(paints[node.topic.id] ?? paints[parent.topic.id])}/>
          </g>;
        }
      }
      if (structure === "timeline") {
        if (parent.topic.parent === null) {
          const axisY = parent.y + parent.h / 2;
          const cx = node.x + node.w / 2;
          const endY = node.y + node.h / 2 < axisY ? node.y + node.h : node.y;
          return <g key={`edge-${node.topic.id}`}>
            <path data-mind-branch={node.topic.id} d={`M${cx},${axisY} V${endY}`} {...lineProps(paints[node.topic.id] ?? paints[parent.topic.id])}/>
          </g>;
        }
        const sx = parent.x + 10, cy = node.y + node.h / 2;
        const sy = node.y < parent.y ? parent.y : parent.y + parent.h;
        return <g key={`edge-${node.topic.id}`}>
          <path data-mind-branch={node.topic.id} d={`M${sx},${sy} V${cy} H${node.x}`} {...lineProps(paints[node.topic.id] ?? paints[parent.topic.id])}/>
        </g>;
      }
      const startX = parent.x + parent.w, startY = parent.y + parent.h / 2, endY = node.y + node.h / 2, mid = startX + 30;
      return <g key={`edge-${node.topic.id}`}><path d={`M${startX},${startY} H${mid} V${endY}`} {...lineProps(paints[parent.topic.id])}/><path data-mind-branch={node.topic.id} d={`M${mid},${endY} H${node.x}`} {...lineProps(paints[node.topic.id])}/></g>;
    })}
    {nodes.map((node) => {
      const root = node.topic.parent === null, active = selected === node.topic.id, relSource = relationFromId === node.topic.id, isEditing = editing?.id === node.topic.id, isEditingDescription = descriptionEditing?.id === node.topic.id, description = mindDescriptionAt(descriptions, node.topic.id), descriptionStyle = mindDescriptionStyleAt(descriptionStyles, node.topic.id), descriptionSize = descriptionStyle?.size ?? 12, descriptionLineHeight = Math.ceil(descriptionSize * 1.35), descriptionLines = description ? mindDescriptionLines(description, descriptionSize) : [], style = styles[node.topic.id], paint = paints[node.topic.id], format = textFormats[node.topic.id], size = style?.size ?? (root ? 16 : 14), shape = style?.shape ?? (root ? "rect" : "text"), align = format?.align ?? (root || shape !== "text" ? "center" : "left"), titleHeight = mindTitleHeight(node.topic, styles), titleCenter = node.y + titleHeight / 2;
      const chars = [...node.topic.text], limit = Math.max(1, Math.floor((node.w - 32) / size)), label = chars.length > limit ? chars.slice(0, limit).join("") + "…" : node.topic.text;
      const textX = align === "center" ? node.x + node.w / 2 : align === "right" ? node.x + node.w - 8 : node.x + 8, anchor = align === "center" ? "middle" : align === "right" ? "end" : "start";
      const labelWidth = [...label].reduce((sum, ch) => sum + (/[\u2e80-\uffff]/.test(ch) ? size : size * 0.58), 0), highlightX = align === "center" ? textX - labelWidth / 2 : align === "right" ? textX - labelWidth : textX;
      const decoration = [format?.underline ? "underline" : "", format?.strike ? "line-through" : ""].filter(Boolean).join(" ");
      return <g key={node.topic.id} pointerEvents={onSelect ? undefined : "none"} data-mind-topic={node.topic.id} onPointerDown={onSelect ? (event) => { event.stopPropagation(); onSelect(node.topic, event); } : undefined} onContextMenu={onContextMenu ? (event) => { event.preventDefault(); event.stopPropagation(); onContextMenu(node.topic, event); } : undefined} onDoubleClick={onEdit ? (event) => { event.stopPropagation(); onEdit(node.topic); } : undefined} style={{ cursor: onSelect ? "pointer" : undefined }}>
        <title>{node.topic.text}</title>
        <rect x={node.x} y={node.y} width={node.w} height={node.h} rx={shape === "oval" ? node.h / 2 : shape === "rect" ? 6 : 0} fill={gpuBacked || shape === "text" ? "transparent" : paint?.fill ?? (root ? "#5b7ff1" : "none")} fillOpacity={(paint?.fillOpacity ?? 100) / 100} stroke={!gpuBacked && shape !== "text" && (!root || paint?.stroke) ? paint?.stroke ?? "#5b7ff1" : "transparent"} strokeWidth={paint?.width ?? 2} strokeOpacity={(paint?.opacity ?? 100) / 100} strokeDasharray={paint?.line === "dashed" ? "6 4" : paint?.line === "dotted" ? "2 3" : undefined}/>
        <rect data-mind-outline x={node.x} y={node.y} width={node.w} height={node.h} fill="none" stroke={relSource ? "#7b56d9" : !gpuBacked && active ? "#3370ff" : "transparent"} strokeWidth={2} strokeDasharray={relSource ? "4 3" : undefined}/>
        {!isEditing && !!label && format?.highlight && <rect x={highlightX - 2} y={titleCenter - size * 0.6} width={labelWidth + 4} height={size * 1.2} fill={format.highlight} pointerEvents="none"/>}
        {!isEditing && <text data-mind-placeholder={!node.topic.text ? "true" : undefined} x={textX} y={titleCenter} dominantBaseline="central" textAnchor={anchor} fill={node.topic.text ? style?.color ?? mindDefaultTextColor(root, shape, paint) : (mindDefaultTextColor(root, shape, paint) === "#ffffff" ? "rgba(255,255,255,0.78)" : "#a3a8af")} fontSize={size} fontWeight={format?.bold ? 700 : undefined} fontStyle={format?.italic ? "italic" : undefined} textDecoration={decoration || undefined}>{label || (onSelect ? t("输入文本") : "")}</text>}
        {isEditing && <foreignObject x={node.x} y={node.y} width={node.w} height={titleHeight}>
          <input autoFocus aria-label={t("思维导图节点文字")} maxLength={500} value={editing.value} onPointerDown={(event) => event.stopPropagation()} onChange={(event) => onDraft?.(event.target.value)} onBlur={() => onFinish?.()} onKeyDown={(event) => { event.stopPropagation(); if (event.nativeEvent.isComposing) return; if (event.key === "Enter") { event.preventDefault(); onFinish?.(); } if (event.key === "Escape") { event.preventDefault(); onCancel?.(); } }} style={{ width: "100%", height: "100%", boxSizing: "border-box", border: "2px solid #3370ff", outline: "none", padding: "0 6px", borderRadius: 3, fontSize: size, fontWeight: format?.bold ? 700 : undefined, fontStyle: format?.italic ? "italic" : undefined, textDecoration: decoration || undefined, textAlign: align, color: style?.color ?? "#1f2329", background: format?.highlight ?? "#fff" }}/>
        </foreignObject>}
        {!isEditingDescription && descriptionStyle?.highlight && descriptionLines.map((line, index) => <rect key={`description-highlight-${index}`} x={node.x + 6} y={node.y + titleHeight + index * descriptionLineHeight} width={mindDescriptionTextWidth(line, descriptionSize) + 4} height={descriptionLineHeight} fill={descriptionStyle.highlight} pointerEvents="none"/>)}
        {!isEditingDescription && description && <text data-mind-description x={node.x + 8} y={node.y + titleHeight + descriptionSize} fontSize={descriptionSize} fill={descriptionStyle?.color ?? "#8f959e"} onDoubleClick={onEditDescription ? (event) => { event.stopPropagation(); onEditDescription(node.topic); } : undefined}>{descriptionLines.map((line, index) => <tspan key={index} x={node.x + 8} dy={index ? descriptionLineHeight : 0}>{line || "\u00a0"}</tspan>)}</text>}
        {isEditingDescription && <foreignObject x={node.x + 4} y={node.y + titleHeight} width={node.w - 8} height={node.h - titleHeight}>
          <textarea autoFocus aria-label={t("思维导图节点描述")} maxLength={2000} value={descriptionEditing.value} onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onChange={(event) => onDescriptionDraft?.(event.target.value)} onBlur={() => onDescriptionFinish?.()} onKeyDown={(event) => { event.stopPropagation(); if (event.nativeEvent.isComposing) return; if (event.key === "Escape") { event.preventDefault(); onDescriptionCancel?.(); } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); onDescriptionFinish?.(); } }} placeholder={t("输入描述")} style={{ width: "100%", height: "100%", boxSizing: "border-box", resize: "none", border: "1px solid #3370ff", outline: "none", padding: "2px 4px", fontSize: descriptionSize, lineHeight: `${descriptionLineHeight}px`, color: descriptionStyle?.color ?? "#646a73", background: descriptionStyle?.highlight ?? "#fff" }}/>
        </foreignObject>}
        {(() => {
          const badge = badges[node.topic.id];
          if (!badge) return null;
          let cursorX = node.x;
          const badgeY = node.y - 18;
          const parts: React.ReactNode[] = [];
          if (badge.priority !== undefined) {
            const meta = priorityBadgeMeta(badge.priority);
            const w = 24;
            parts.push(
              <g key="priority" data-mind-badge-priority={badge.priority}>
                <rect x={cursorX} y={badgeY} width={w} height={16} rx={4} fill={meta.bg} stroke={meta.border} strokeWidth={1} />
                <text x={cursorX + w / 2} y={badgeY + 8} textAnchor="middle" dominantBaseline="central" fontSize={10} fontWeight={700} fill={meta.fg}>{meta.label}</text>
              </g>,
            );
            cursorX += w + 4;
          }
          if (badge.progress !== undefined) {
            const progColor = badge.progress === 100 ? "#2ea121" : "#3370ff";
            const labelText = `${badge.progress}%`;
            const w = Math.max(38, Math.round(16 + labelText.length * 6 + 6));
            const cx = cursorX + 8;
            const cy = badgeY + 8;
            parts.push(
              <g key="progress" data-mind-badge-progress={badge.progress}>
                <rect x={cursorX} y={badgeY} width={w} height={16} rx={8} fill="#ffffff" stroke="#d4d7dc" strokeWidth={1} />
                <circle cx={cx} cy={cy} r={4.5} fill="#ffffff" stroke={progColor} strokeWidth={1.1} />
                {badge.progress > 0 && <path d={progressWedgePath(cx, cy, 4, badge.progress)} fill={progColor} />}
                <text x={cursorX + 16} y={cy} dominantBaseline="central" fontSize={9.5} fontWeight={600} fill="#1f2329">{labelText}</text>
              </g>,
            );
            cursorX += w + 4;
          }
          if (badge.tag) {
            const w = Math.max(28, Math.round(pillTextWidth(badge.tag, 10) + 12));
            parts.push(
              <g key="tag" data-mind-badge-tag={badge.tag}>
                <rect x={cursorX} y={badgeY} width={w} height={16} rx={8} fill="#f0ebff" stroke="#d3bff8" strokeWidth={1} />
                <text x={cursorX + w / 2} y={badgeY + 8} textAnchor="middle" dominantBaseline="central" fontSize={10} fontWeight={500} fill="#6425d0">{badge.tag}</text>
              </g>,
            );
          }
          if (!parts.length) return null;
          return <g data-mind-badge={node.topic.id} pointerEvents="none">{parts}</g>;
        })()}
      </g>;
    })}
    {renderedSummaries.map(({ parentId, summary, brace }) => {
      const pillW = Math.max(44, Math.round(pillTextWidth(summary.label, 12) + 20));
      const pillH = 26;
      const pillX =
        brace.anchor === "start"
          ? brace.labelX
          : brace.anchor === "end"
            ? brace.labelX - pillW
            : brace.labelX - pillW / 2;
      const pillY = brace.labelY - pillH / 2;
      return (
        <g key={`summary-${parentId}`} data-mind-summary={parentId}>
          <path
            d={brace.path}
            fill="none"
            stroke={summary.color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            pointerEvents="none"
          />
          <g
            data-mind-summary-pill={parentId}
            style={{ cursor: onEditSummary ? "pointer" : undefined }}
            onPointerDown={onEditSummary ? (e) => e.stopPropagation() : undefined}
            onDoubleClick={onEditSummary ? (e) => { e.stopPropagation(); onEditSummary(parentId); } : undefined}
          >
            <rect
              x={pillX}
              y={pillY}
              width={pillW}
              height={pillH}
              rx={13}
              fill="#ffffff"
              stroke={summary.color}
              strokeWidth={1.5}
            />
            <text
              x={pillX + pillW / 2}
              y={brace.labelY}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={12}
              fontWeight={600}
              fill={summary.color}
              pointerEvents="none"
            >
              {summary.label}
            </text>
          </g>
        </g>
      );
    })}
    {visibleRelations.map((rel) => {
      const fromPos = byId.get(rel.fromId)!, toPos = byId.get(rel.toId)!;
      const d = mindRelationCurvePath(fromPos, toPos);
      const mid = mindRelationLabelPoint(fromPos, toPos);
      const pillW = rel.label ? Math.max(36, [...rel.label].reduce((sum, ch) => sum + (/[\u2e80-\uffff]/.test(ch) ? 11 : 6.5), 0) + 14) : 0;
      return <g key={`rel-${rel.id}`} data-mind-relation={rel.id} data-mind-relation-from={rel.fromId} data-mind-relation-to={rel.toId}>
        {onRemoveRelation && <path d={d} fill="none" stroke="transparent" strokeWidth={14} style={{ cursor: "pointer" }} onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => { e.stopPropagation(); onRemoveRelation(rel.id); }}><title>{t("双击删除关联线")}</title></path>}
        <path d={d} fill="none" stroke="#7b56d9" strokeWidth={2} strokeDasharray="6 4" markerEnd="url(#mind-rel-arrow)" pointerEvents="none"/>
        {rel.label && <g pointerEvents="none">
          <rect x={mid.x - pillW / 2} y={mid.y - 10} width={pillW} height={20} rx={10} fill="#f3eeff" stroke="#7b56d9" strokeWidth={1}/>
          <text x={mid.x} y={mid.y} textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={500} fill="#5b35b5">{rel.label}</text>
        </g>}
      </g>;
    })}
    {nodes.map((node) => {
      const count = descendants(node.topic.id), folded = collapsed.has(node.topic.id);
      if (!count || (!folded && (!onFold || (onSelect && selected !== node.topic.id)))) return null;
      const x = structure === "org" ? node.x + node.w / 2 : node.x + node.w + 10;
      const y = structure === "org" ? node.y + node.h + 10 : node.y + node.h / 2;
      return <g key={`fold-${node.topic.id}`} data-mind-fold={node.topic.id} data-mind-fold-expanded={!folded ? "true" : undefined} role={onFold ? "button" : undefined} tabIndex={onFold ? 0 : undefined} aria-label={onFold ? (folded ? t("展开「{title}」", { title: node.topic.text || t("节点") }) : t("折叠「{title}」", { title: node.topic.text || t("节点") })) : undefined} aria-expanded={onFold ? !folded : undefined} pointerEvents={onFold ? undefined : "none"} style={{ cursor: onFold ? "pointer" : undefined }} onPointerDown={onFold ? (event) => event.stopPropagation() : undefined} onClick={onFold ? (event) => { event.stopPropagation(); onFold(node.topic.id); } : undefined} onKeyDown={onFold ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); onFold(node.topic.id); } } : undefined}>
        <circle cx={x} cy={y} r={folded && count > 9 ? 10 : 8} fill="#fff" stroke="#3370ff"/>
        <text x={x} y={y} textAnchor="middle" dominantBaseline="central" fontSize={folded ? 10 : 16} fill="#3370ff">{folded ? count > 99 ? "99+" : count : "‹"}</text>
      </g>;
    })}
    {onAddChild && !editing && !descriptionEditing && nodes.filter((node) => node.topic.id === selected).map((node) => {
      const x = structure === "org" ? node.x + node.w / 2 + (descendants(node.topic.id) ? 24 : 0) : node.x + node.w + (descendants(node.topic.id) ? 38 : 18);
      const y = structure === "org" ? node.y + node.h + (descendants(node.topic.id) ? 10 : 18) : node.y + node.h / 2;
      return <g key={`add-${node.topic.id}`} data-mind-add={node.topic.id} role="button" tabIndex={0} aria-label={t("为「{title}」添加子节点", { title: node.topic.text || t("节点") })} style={{ cursor: "pointer" }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onAddChild(node.topic.id); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); onAddChild(node.topic.id); } }}>
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
        <text x={dragPreview.x} y={dragPreview.y} textAnchor="middle" dominantBaseline="central" fontSize={14} fill="#1f2329">{source.topic.text || t("输入文本")}</text>
      </g>;
    })()}
  </g>;
}
