import type { SurveyQuestion, SurveyResponseRecord } from "@/lib/api";

/**
 * Computes the ordered visible questions given current respondent answers,
 * evaluating forward skip rules (`whenOption -> jumpToQuestionId | "__END__"`).
 */
export function computeVisibleSurveyQuestions(
  questions: readonly SurveyQuestion[],
  answers: Record<string, unknown>,
): SurveyQuestion[] {
  const indexById = new Map<string, number>();
  questions.forEach((q, i) => indexById.set(q.id, i));
  const out: SurveyQuestion[] = [];
  for (let i = 0; i < questions.length;) {
    const q = questions[i];
    out.push(q);
    let next = i + 1;
    if (q.skipRules && q.skipRules.length > 0) {
      const raw = answers[q.id];
      const selected = new Set<string>();
      if (typeof raw === "string" && raw) selected.add(raw);
      else if (Array.isArray(raw)) {
        for (const item of raw) if (typeof item === "string" && item) selected.add(item);
      }
      for (const rule of q.skipRules) {
        if (selected.has(rule.whenOption)) {
          if (rule.jumpToQuestionId === "__END__") {
            next = questions.length;
          } else {
            const targetIdx = indexById.get(rule.jumpToQuestionId);
            if (targetIdx !== undefined && targetIdx > i) next = targetIdx;
          }
          break;
        }
      }
    }
    i = next;
  }
  return out;
}

function escapeCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function formatAnswerForCsv(q: SurveyQuestion, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (q.type === "signature" && typeof value === "string") return value ? "[已签名]" : "";
  if (Array.isArray(value)) return value.join(" > ");
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}:${String(v ?? "")}`)
      .join("; ");
  }
  return String(value);
}

/** Builds a UTF-8 CSV string of survey submissions for spreadsheet download. */
export function buildSurveyCsv(
  questions: readonly SurveyQuestion[],
  responses: readonly SurveyResponseRecord[],
): string {
  const header = ["序号", "填写者", "提交时间", ...questions.map((q) => q.title)];
  const rows = responses.map((r, idx) => [
    String(idx + 1),
    r.respondentName || "匿名",
    r.submittedAt,
    ...questions.map((q) => formatAnswerForCsv(q, r.answers?.[q.id])),
  ]);
  return [header, ...rows].map((row) => row.map(escapeCsvCell).join(",")).join("\n");
}
