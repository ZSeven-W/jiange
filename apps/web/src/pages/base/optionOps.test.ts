import { describe, expect, it } from "vitest";
import type { Field } from "@/lib/api";
import { deleteOption, moveOption, recolorOption, renameOption } from "./optionOps";

const f: Field = { id: 2, name: "状态", type: "select", position: 2, options: ["未开始", "进行中", "已完成"], optionColors: [0, 2] };

describe("kanban option edits", () => {
  it("renames with a rename map and keeps colours parallel", () => {
    expect(renameOption(f, "进行中", "处理中")).toEqual({ options: ["未开始", "处理中", "已完成"], optionColors: [0, 2, -1], optionRenames: { 进行中: "处理中" } });
    expect(renameOption(f, "进行中", "已完成")).toBeNull();
    expect(renameOption(f, "进行中", "  ")).toBeNull();
  });
  it("recolours and deletes", () => {
    expect(recolorOption(f, "已完成", 5)?.optionColors).toEqual([0, 2, 5]);
    expect(deleteOption(f, "未开始")).toEqual({ options: ["进行中", "已完成"], optionColors: [2, -1] });
  });
  it("moves options with their colours", () => {
    expect(moveOption(f, "已完成", 0)).toEqual({ options: ["已完成", "未开始", "进行中"], optionColors: [-1, 0, 2] });
    expect(moveOption(f, "未开始", 3)).toEqual({ options: ["进行中", "已完成", "未开始"], optionColors: [2, -1, 0] });
    expect(moveOption(f, "进行中", 1)).toBeNull();
    expect(moveOption(f, "进行中", 2)).toBeNull();
  });
});
