/** 飞书高亮块配色（背景, 边框）：默认橙色，其后蓝、绿、灰、黄、紫、红。编辑器与只读渲染共用。 */
export const CALLOUT_COLORS: [string, string][] = [["#FEF1E1", "#F9D7AF"], ["#E1EAFF", "#BACEFD"], ["#D9F5D6", "#B7EDB1"], ["#F5F6F7", "#DEE0E3"], ["#FFF4C9", "#F8E6AB"], ["#F8DEF8", "#EFB9EF"], ["#FDE2E2", "#F8C4C2"]];

export function calloutStyle(color: string | undefined): { background: string; borderColor: string } {
  const [background, borderColor] = CALLOUT_COLORS[Number(color ?? 0)] ?? CALLOUT_COLORS[0];
  return { background, borderColor };
}
