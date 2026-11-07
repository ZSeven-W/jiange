import { useState } from "react";
import { SearchIcon } from "@/components/FeishuIcons";
import { parseMarkdown } from "@/lib/markdown";

export interface StarterTemplate { id: string; name: string; body: string; color: string; }
export const STARTER_TEMPLATES: StarterTemplate[] = [
  { id: "meeting", name: "会议记录（简洁版）", color: "#e8efff", body: "## 会议信息\n\n会议时间：\n\n参会人员：\n\n## 会议议题\n\n- 议题一\n\n## 讨论与结论\n\n- \n\n## 待办事项\n\n- [ ] 待办事项" },
  { id: "weekly", name: "工作周报", color: "#f2f4f8", body: "## 本周工作\n\n- 工作进展\n\n## 下周计划\n\n- 计划事项\n\n## 需要协助\n\n- " },
  { id: "todo", name: "待办清单", color: "#eef6f2", body: "## 本周待办\n\n- [ ] 任务一\n- [ ] 任务二\n\n## 已完成\n\n- [x] " },
  { id: "project", name: "长期项目方案与执行", color: "#f6f1eb", body: "## 项目背景\n\n在这里描述项目背景。\n\n## 项目目标\n\n- 目标一\n\n## 执行计划\n\n- [ ] 任务与负责人\n\n## 风险与问题\n\n- " },
  { id: "notes", name: "读书笔记", color: "#f6efff", body: "## 基本信息\n\n书名：\n\n作者：\n\n## 核心观点\n\n- \n\n## 我的思考\n\n- " },
  { id: "brief", name: "项目简报", color: "#fff1ed", body: "## 项目概览\n\n项目名称：\n\n## 当前进展\n\n- \n\n## 下一步计划\n\n- " },
];

/** Preview the same blocks that will be inserted instead of decorative placeholders. */
function TemplatePreview({ template }: { template: StarterTemplate }) {
  const blocks = parseMarkdown(template.body);
  return <span aria-hidden="true" className="mx-2 mt-1.5 block h-[119px] overflow-hidden rounded-[2px] border border-[#f0f1f3] bg-white px-[7px] pb-2 pt-[5px] text-[#525866]">
    {blocks.map((block, index) => {
      const text = block.spans.map((span) => span.text).join("") || block.text;
      if (/^h[1-3]$/.test(block.type)) return <span key={index} className="mb-[2px] mt-[4px] block truncate text-[7px] font-semibold leading-[10px] text-[#1f2329] first:mt-0">{text}</span>;
      if (block.type === "todo") return <span key={index} className="flex min-h-[10px] items-start gap-[3px] text-[6px] leading-[10px]"><span className={`mt-[2px] grid size-[6px] shrink-0 place-items-center rounded-[1px] border ${block.props.checked ? "border-[#3370ff] bg-[#3370ff] text-white" : "border-[#aeb5c0]"}`}>{block.props.checked ? "✓" : ""}</span><span className="min-w-0 truncate">{text}</span></span>;
      if (block.type === "bullet" || block.type === "ordered") return <span key={index} className="flex min-h-[10px] items-start gap-[4px] text-[6px] leading-[10px]"><span className="shrink-0 text-[#8f959e]">•</span><span className="min-w-0 truncate">{text}</span></span>;
      return <span key={index} className="block min-h-[10px] truncate text-[6px] leading-[10px]">{text}</span>;
    })}
  </span>;
}

function MoreTemplatesIcon() {
  return <span aria-hidden="true" className="relative block h-12 w-12">
    <span className="absolute left-[7px] top-[5px] h-[36px] w-[30px] rounded-[2px] bg-[#e5e6e8]" />
    <span className="absolute left-[13px] top-[17px] h-[27px] w-[20px] rounded-[2px] border border-[#99a8c4] bg-white px-[3px] pt-[5px]"><span className="mb-[3px] block h-px w-full bg-[#aebbd3]"/><span className="block h-px w-3/4 bg-[#aebbd3]"/></span>
    <span className="absolute right-0 top-0 grid size-[18px] place-items-center rounded-full bg-[#3370ff] text-[14px] leading-none text-white">›</span>
  </span>;
}

/** Real starter documents shown only while the collaborative body is empty. */
export function StarterTemplates({ onChoose, onHide, compact = false, disabled = false }: { onChoose: (template: StarterTemplate) => void; onHide: () => void; compact?: boolean; disabled?: boolean }) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const items = STARTER_TEMPLATES.filter((t) => t.name.includes(query.trim()));
  const visible = expanded || query.trim() ? items : items.slice(0, 4);
  return <section className={compact ? "w-full" : "mt-auto w-full pt-20"} aria-label="文档模板" data-starter-templates>
    <div className="mb-4 flex items-center justify-between gap-4">
      <label className="flex h-8 w-[240px] max-w-full items-center gap-2 rounded-md border px-3 text-subtle focus-within:border-primary"><SearchIcon className="size-[15px] shrink-0"/><span className="sr-only">搜索模板</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="输入关键词搜索模板" className="w-full min-w-0 bg-transparent text-[16px] text-foreground outline-none placeholder:text-subtle sm:text-[13px]"/></label>
      <button type="button" onClick={onHide} className="shrink-0 rounded px-1 text-[13px] text-muted-foreground hover:text-foreground">隐藏</button>
    </div>
    <div className="flex gap-4 overflow-x-auto pb-1">
      {visible.map((t) => <button key={t.id} type="button" disabled={disabled} onClick={() => onChoose(t)} className="group h-[162px] w-[150px] shrink-0 overflow-hidden rounded-lg border bg-surface text-left shadow-[0_2px_10px_rgba(31,35,41,0.05)] transition-shadow hover:shadow-[0_5px_18px_rgba(31,35,41,0.12)] focus-visible:outline-2 focus-visible:outline-primary" data-starter-template={t.id}>
        <span className="block truncate px-2.5 pt-2 text-[12px] font-medium">{t.name}</span>
        <TemplatePreview template={t} />
      </button>)}
      {!query.trim() && !expanded && <button type="button" disabled={disabled} onClick={() => setExpanded(true)} className="flex h-[162px] w-[150px] shrink-0 flex-col items-center justify-center gap-2 rounded-lg border bg-surface text-[13px] text-muted-foreground shadow-[0_2px_10px_rgba(31,35,41,0.05)] hover:bg-hover/40"><MoreTemplatesIcon />更多模板</button>}
      {items.length === 0 && <p className="py-8 text-[13px] text-subtle">没有找到匹配的模板</p>}
    </div>
  </section>;
}
