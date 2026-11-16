export interface StarterTemplate { id: string; name: string; body: string; color: string; }

export const STARTER_TEMPLATES: StarterTemplate[] = [
  { id: "meeting", name: "会议记录（简洁版）", color: "#e8efff", body: "## 会议信息\n\n会议时间：\n\n参会人员：\n\n## 会议议题\n\n- 议题一\n\n## 讨论与结论\n\n- \n\n## 待办事项\n\n- [ ] 待办事项" },
  { id: "weekly", name: "工作周报", color: "#f2f4f8", body: "## 本周工作\n\n- 工作进展\n\n## 下周计划\n\n- 计划事项\n\n## 需要协助\n\n- " },
  { id: "todo", name: "待办清单", color: "#eef6f2", body: "## 本周待办\n\n- [ ] 任务一\n- [ ] 任务二\n\n## 已完成\n\n- [x] " },
  { id: "project", name: "长期项目方案与执行", color: "#f6f1eb", body: "## 项目背景\n\n在这里描述项目背景。\n\n## 项目目标\n\n- 目标一\n\n## 执行计划\n\n- [ ] 任务与负责人\n\n## 风险与问题\n\n- " },
  { id: "notes", name: "读书笔记", color: "#f6efff", body: "## 基本信息\n\n书名：\n\n作者：\n\n## 核心观点\n\n- \n\n## 我的思考\n\n- " },
  { id: "brief", name: "项目简报", color: "#fff1ed", body: "## 项目概览\n\n项目名称：\n\n## 当前进展\n\n- \n\n## 下一步计划\n\n- " },
];
