/**
 * 流程图模板（对应飞书画板的「从模板创建」）。每次调用都生成新 ID。
 */
import { autoLayout, newFlowId, type FlowEdge, type FlowGraph, type FlowNode, type Shape } from "./model";

export interface FlowTemplate { id: string; label: string; desc: string; build: (theme: string) => FlowGraph }

type N = [key: string, shape: Shape, text: string, x?: number, y?: number, w?: number, h?: number, extra?: Partial<FlowNode>];
type E = [from: string, to: string, extra?: Partial<FlowEdge>];

const SIZE: Partial<Record<Shape, [number, number]>> = { terminator: [140, 52], diamond: [150, 90], cylinder: [110, 80], document: [140, 70], parallelogram: [150, 60] };

function make(theme: string, nodes: N[], edges: E[], layout: boolean): FlowGraph {
  const ids = new Map(nodes.map(([k]) => [k, newFlowId("n")]));
  const out: FlowGraph = {
    theme,
    nodes: nodes.map(([k, shape, text, x = 0, y = 0, w, h, extra], i) => {
      const [dw, dh] = SIZE[shape] ?? [140, 60];
      return { id: ids.get(k)!, shape, text, x, y, w: w ?? dw, h: h ?? dh, z: shape === "swimlane" || shape === "swimlaneV" ? i - 1000 : i, ...extra };
    }),
    edges: edges.map(([a, b, extra]) => ({ id: newFlowId("e"), from: ids.get(a)!, to: ids.get(b)!, ...extra })),
  };
  return layout ? autoLayout(out) : out;
}

export const FLOW_TEMPLATES: FlowTemplate[] = [
  {
    id: "basic", label: "基础流程图", desc: "开始、处理、判断、结束",
    build: (t) => make(t, [["s", "terminator", "开始"], ["a", "rect", "步骤一"], ["d", "diamond", "是否通过？"], ["b", "rect", "步骤二"], ["e", "terminator", "结束"]],
      [["s", "a"], ["a", "d"], ["d", "b", { label: "是" }], ["d", "a", { label: "否", dashed: true }], ["b", "e"]], true),
  },
  {
    id: "approval", label: "审批流程", desc: "提交、逐级审批、归档",
    build: (t) => make(t, [["s", "terminator", "提交申请"], ["m", "rect", "主管审批"], ["d", "diamond", "金额 > 1 万？"], ["f", "rect", "财务复核"], ["r", "parallelogram", "通知申请人"], ["db", "cylinder", "归档"]],
      [["s", "m"], ["m", "d"], ["d", "f", { label: "是" }], ["d", "r", { label: "否" }], ["f", "r"], ["r", "db"]], true),
  },
  {
    id: "swimlane", label: "跨部门泳道图", desc: "按角色分泳道的业务流程",
    build: (t) => make(t, [
      ["l1", "swimlane", "申请人", 0, 0, 760, 140], ["l2", "swimlane", "部门主管", 0, 140, 760, 140], ["l3", "swimlane", "财务", 0, 280, 760, 140],
      ["a", "terminator", "发起报销", 70, 44], ["b", "rect", "填写报销单", 270, 40],
      ["c", "diamond", "审批通过？", 260, 165], ["d", "rect", "退回修改", 480, 180],
      ["e", "rect", "打款", 270, 320], ["f", "terminator", "完成", 520, 324],
    ], [["a", "b"], ["b", "c"], ["c", "d", { label: "否" }], ["d", "b", { dashed: true }], ["c", "e", { label: "是" }], ["e", "f"]], false),
  },
  {
    id: "sequence", label: "时序图", desc: "参与者之间的消息顺序",
    build: (t) => {
      const cx = [60, 300, 540]; // 生命线中心
      const msgs: [number, number, string, boolean][] = [[0, 1, "点击登录", false], [1, 2, "POST /login", false], [2, 1, "返回令牌", true], [1, 0, "进入首页", true]];
      const nodes: N[] = [["L0", "lifeline", "用户", 0, 0, 120, 340], ["L1", "lifeline", "前端", 240, 0, 120, 340], ["L2", "lifeline", "服务端", 480, 0, 120, 340]];
      const edges: E[] = [];
      msgs.forEach(([a, b, text, dashed], i) => {
        const y = 90 + i * 56;
        nodes.push([`a${i}`, "rect", "", cx[a] - 10, y, 20, 28], [`b${i}`, "rect", "", cx[b] - 10, y, 20, 28]);
        edges.push([`a${i}`, `b${i}`, { label: text, kind: "straight", fromPort: b > a ? "right" : "left", toPort: b > a ? "left" : "right", ...(dashed ? { dashed: true } : {}) }]);
      });
      return make(t, nodes, edges, false);
    },
  },
  {
    id: "class", label: "类图", desc: "类、属性、方法与继承",
    build: (t) => make(t, [
      ["a", "class", "User\n+ id: number\n+ name: string\n+ login()", 220, 0, 200, 120],
      ["b", "class", "Admin\n+ role: string\n+ ban(user)", 60, 220, 200, 104],
      ["c", "class", "Member\n+ level: number\n+ upgrade()", 380, 220, 200, 104],
    ], [["b", "a", { kind: "orthogonal" }], ["c", "a", { kind: "orthogonal" }]], false),
  },
];
