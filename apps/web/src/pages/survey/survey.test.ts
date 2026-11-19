import { describe, expect, it } from "vitest";
import type { SurveyQuestion, SurveyResponseRecord } from "@/lib/api";
import { buildSurveyCsv, computeVisibleSurveyQuestions } from "./skip-logic";

const questions: SurveyQuestion[] = [
  {
    id: "q1",
    type: "single",
    title: "是否使用过鉴格云文档？",
    required: true,
    options: ["经常使用", "从未使用"],
    skipRules: [{ whenOption: "从未使用", jumpToQuestionId: "q4" }],
  },
  { id: "q2", type: "rating", title: "满意度评分", required: true, maxRating: 5 },
  { id: "q3", type: "matrix", title: "模块评价", required: false, matrixRows: ["文档"], matrixCols: ["好", "中"] },
  { id: "q4", type: "signature", title: "签名确认", required: true },
];

describe("standalone survey skip logic and CSV export", () => {
  it("evaluates forward skip rules and end jumps without loops", () => {
    expect(computeVisibleSurveyQuestions(questions, {}).map((q) => q.id)).toEqual(["q1", "q2", "q3", "q4"]);
    expect(computeVisibleSurveyQuestions(questions, { q1: "经常使用" }).map((q) => q.id)).toEqual(["q1", "q2", "q3", "q4"]);
    expect(computeVisibleSurveyQuestions(questions, { q1: "从未使用" }).map((q) => q.id)).toEqual(["q1", "q4"]);

    const endJump: SurveyQuestion[] = [
      { ...questions[0], skipRules: [{ whenOption: "从未使用", jumpToQuestionId: "__END__" }] },
      questions[1],
      questions[3],
    ];
    expect(computeVisibleSurveyQuestions(endJump, { q1: "从未使用" }).map((q) => q.id)).toEqual(["q1"]);
  });

  it("exports structured CSV including matrix, ranking, and signature markers", () => {
    const responses: SurveyResponseRecord[] = [
      {
        id: 1,
        surveyId: 10,
        respondentName: "张三",
        submittedAt: "2026-11-19T09:00:00Z",
        answers: {
          q1: "经常使用",
          q2: 5,
          q3: { 文档: "好" },
          q4: "data:image/png;base64,abc",
        },
      },
    ];
    const csv = buildSurveyCsv(questions, responses);
    expect(csv).toContain("序号,填写者,提交时间,是否使用过鉴格云文档？,满意度评分,模块评价,签名确认");
    expect(csv).toContain("1,张三,2026-11-19T09:00:00Z,经常使用,5,文档:好,[已签名]");
  });
});
