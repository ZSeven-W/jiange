import { layoutMindTopics, type MindTopic } from "./mindmap";

export function MindMapSvg({ topics, selected, editing, onSelect, onEdit, onDraft, onFinish, onCancel }: {
  topics: readonly MindTopic[];
  selected?: string | null;
  editing?: { id: string; value: string } | null;
  onSelect?: (topic: MindTopic) => void;
  onEdit?: (topic: MindTopic) => void;
  onDraft?: (value: string) => void;
  onFinish?: () => void;
  onCancel?: () => void;
}) {
  const nodes = layoutMindTopics(topics), byId = new Map(nodes.map((node) => [node.topic.id, node]));
  return <g data-mindmap>
    {nodes.map((node) => {
      const parent = node.topic.parent ? byId.get(node.topic.parent) : null;
      if (!parent) return null;
      const startX = parent.x + parent.w, startY = parent.y + parent.h / 2, endY = node.y + node.h / 2, mid = startX + 30;
      return <path key={`edge-${node.topic.id}`} d={`M${startX},${startY} H${mid} V${endY} H${node.x}`} fill="none" stroke="#5b7ff1" strokeWidth={2} pointerEvents="none"/>;
    })}
    {nodes.map((node) => {
      const root = node.topic.parent === null, active = selected === node.topic.id, isEditing = editing?.id === node.topic.id;
      const chars = [...node.topic.text], label = chars.length > (root ? 14 : 15) ? chars.slice(0, root ? 14 : 15).join("") + "…" : node.topic.text;
      return <g key={node.topic.id} pointerEvents={onSelect ? undefined : "none"} data-mind-topic={node.topic.id} onPointerDown={onSelect ? (event) => { event.stopPropagation(); onSelect(node.topic); } : undefined} onDoubleClick={onEdit ? (event) => { event.stopPropagation(); onEdit(node.topic); } : undefined} style={{ cursor: onSelect ? "pointer" : undefined }}>
        <title>{node.topic.text}</title>
        <rect data-mind-outline x={node.x} y={node.y} width={node.w} height={node.h} rx={root ? 6 : 3} fill={root ? "#5b7ff1" : "transparent"} stroke={active ? "#3370ff" : "transparent"} strokeWidth={2}/>
        {!isEditing && <text data-mind-placeholder={!node.topic.text ? "true" : undefined} x={root ? node.x + node.w / 2 : node.x + 8} y={node.y + node.h / 2} dominantBaseline="central" textAnchor={root ? "middle" : "start"} fill={node.topic.text ? root ? "#fff" : "#1f2329" : "#a3a8af"} fontSize={root ? 16 : 14}>{label || (onSelect ? "输入文本" : "")}</text>}
        {isEditing && <foreignObject x={node.x} y={node.y} width={node.w} height={node.h}>
          <input autoFocus aria-label="思维导图节点文字" maxLength={500} value={editing.value} onPointerDown={(event) => event.stopPropagation()} onChange={(event) => onDraft?.(event.target.value)} onBlur={() => onFinish?.()} onKeyDown={(event) => { event.stopPropagation(); if (event.nativeEvent.isComposing) return; if (event.key === "Enter") { event.preventDefault(); onFinish?.(); } if (event.key === "Escape") { event.preventDefault(); onCancel?.(); } }} style={{ width: "100%", height: "100%", boxSizing: "border-box", border: "2px solid #3370ff", outline: "none", padding: "0 6px", borderRadius: 3, fontSize: root ? 16 : 14, textAlign: root ? "center" : "left", color: "#1f2329", background: "#fff" }}/>
        </foreignObject>}
      </g>;
    })}
  </g>;
}
