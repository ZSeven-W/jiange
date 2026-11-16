import { describe, expect, it } from "vitest";
import type { Field } from "@/lib/api";
import { aiPasteFields, aiPastePrompt, parseAiPaste } from "./ai-paste";

const fields: Field[] = [
  { id: 1, name: "事项", type: "text", position: 1 },
  { id: 2, name: "状态", type: "select", options: ["进行中", "完成"], position: 2 },
  { id: 3, name: "完成", type: "checkbox", position: 3 },
  { id: 4, name: "截止", type: "date", position: 4 },
  { id: 5, name: "关联", type: "link", position: 5 },
];

describe("AI paste", () => {
  const schema = aiPasteFields(fields);
  it("omits unsupported fields and validates every generated cell", () => {
    expect(schema.map((f) => f.id)).toEqual([1, 2, 3, 4]);
    expect(parseAiPaste('```json\n{"rows":[{"1":"设计","2":"进行中","3":"false","4":"2026-11-14"}]}\n```', schema)).toEqual([{ "1": "设计", "2": "进行中", "3": false, "4": "2026-11-14" }]);
    for (const bad of ['{"rows":[{"1":"设计"},{"2":"其他"}]}', '{"rows":[{"5":"不允许"}]}', '{"rows":[{"4":"2026-02-30"}]}', '{"rows":[{"1":42}]}', '{"rows":[{}]}', "not json"]) expect(parseAiPaste(bad, schema)).toBeNull();
  });
  it("sends pasted content separately from the schema instruction", () => {
    const prompt = aiPastePrompt("事项：设计", schema);
    expect(prompt[0].content).toContain('"name":"事项"');
    expect(prompt[1]).toEqual({ role: "user", content: "事项：设计" });
  });
});
