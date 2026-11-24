import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, CheckCircle2, ClipboardList, Star } from "lucide-react";
import { ApiError, surveysApi, type SurveyQuestion } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { computeVisibleSurveyQuestions } from "./skip-logic";
import { SignaturePad } from "./signature-pad";

export function PublicSurveyPage({ token }: { token: string }) {
  const { t } = useI18n();
  const [respondentName, setRespondentName] = useState("");
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  const query = useQuery({
    queryKey: ["public-survey", token],
    queryFn: () => surveysApi.getPublic(token),
    retry: false,
  });

  const visibleQuestions = useMemo(
    () => computeVisibleSurveyQuestions(query.data?.questions ?? [], answers),
    [query.data?.questions, answers],
  );

  const setAnswer = (qid: string, value: unknown) => {
    setAnswers((prev) => ({ ...prev, [qid]: value }));
    setError("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      // Ensure ranking defaults are captured if visible
      const payload: Record<string, unknown> = { ...answers };
      for (const q of visibleQuestions) {
        if (q.type === "ranking" && !Array.isArray(payload[q.id]) && q.options?.length) {
          payload[q.id] = [...q.options];
        }
      }
      await surveysApi.submitPublic(token, { respondentName: respondentName.trim(), answers: payload });
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("提交问卷失败"));
    } finally {
      setSubmitting(false);
    }
  };

  if (query.isPending) {
    return <div className="grid min-h-full place-items-center bg-[#F5F6F7] p-6 text-sm text-muted-foreground">{t("正在加载问卷…")}</div>;
  }

  if (query.isError) {
    const closed = query.error instanceof ApiError && query.error.status === 410;
    return (
      <div className="grid min-h-full place-items-center bg-[#F5F6F7] p-6">
        <div className="max-w-md rounded-xl border bg-surface p-8 text-center shadow-xs">
          <ClipboardList size={36} className="mx-auto mb-3 text-muted-foreground" />
          <h1 className="text-[18px] font-semibold text-foreground">{closed ? t("该问卷已停止收集") : t("问卷不可访问")}</h1>
          <p className="mt-2 text-[13px] text-muted-foreground">
            {closed ? t("创建者已关闭此问卷的答卷回收。") : t("链接可能已失效或问卷尚未发布。")}
          </p>
        </div>
      </div>
    );
  }

  const sv = query.data;
  if (submitted) {
    return (
      <div className="grid min-h-full place-items-center bg-[#F5F6F7] p-6" data-survey-submitted>
        <div className="w-full max-w-md rounded-xl border bg-surface p-8 text-center shadow-xs">
          <CheckCircle2 size={44} className="mx-auto mb-3 text-emerald-600" />
          <h1 className="text-[20px] font-semibold text-foreground">{t("提交成功，感谢参与！")}</h1>
          <p className="mt-2 text-[13px] text-muted-foreground">{t("您的问卷答复已安全记录。")}</p>
        </div>
      </div>
    );
  }

  if (sv.full) {
    return (
      <div className="grid min-h-full place-items-center bg-[#F5F6F7] p-6">
        <div className="max-w-md rounded-xl border bg-surface p-8 text-center shadow-xs">
          <h1 className="text-[18px] font-semibold text-foreground">{t("该问卷已达到回收上限")}</h1>
          <p className="mt-2 text-[13px] text-muted-foreground">{t("感谢您的关注！")}</p>
        </div>
      </div>
    );
  }

  const renderQuestionControl = (q: SurveyQuestion) => {
    const val = answers[q.id];
    switch (q.type) {
      case "single":
        return (
          <div className="space-y-2">
            {(q.options ?? []).map((opt) => {
              const active = val === opt;
              return (
                <label
                  key={opt}
                  data-public-option={`${q.id}:${opt}`}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-[14px] transition-colors",
                    active ? "border-violet-500 bg-violet-50/60 text-violet-900" : "hover:bg-muted/40",
                  )}
                >
                  <input
                    type="radio"
                    name={q.id}
                    checked={active}
                    onChange={() => setAnswer(q.id, opt)}
                  />
                  <span>{opt}</span>
                </label>
              );
            })}
          </div>
        );
      case "multi": {
        const list = Array.isArray(val) ? (val as string[]) : [];
        return (
          <div className="space-y-2">
            {(q.options ?? []).map((opt) => {
              const checked = list.includes(opt);
              return (
                <label
                  key={opt}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-[14px] transition-colors",
                    checked ? "border-violet-500 bg-violet-50/60 text-violet-900" : "hover:bg-muted/40",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      setAnswer(q.id, checked ? list.filter((x) => x !== opt) : [...list, opt])
                    }
                  />
                  <span>{opt}</span>
                </label>
              );
            })}
          </div>
        );
      }
      case "rating": {
        const max = q.maxRating ?? 5;
        const current = typeof val === "number" ? val : 0;
        return (
          <div className="flex flex-wrap items-center gap-2">
            {Array.from({ length: max }, (_, idx) => idx + 1).map((score) => (
              <button
                key={score}
                type="button"
                data-public-rating={`${q.id}:${score}`}
                onClick={() => setAnswer(q.id, score)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-lg border px-3 py-2 text-[14px] transition-colors",
                  current >= score ? "border-amber-400 bg-amber-50 text-amber-600" : "text-muted-foreground hover:bg-muted/40",
                )}
              >
                <Star size={16} fill={current >= score ? "currentColor" : "none"} />
                {score}
              </button>
            ))}
          </div>
        );
      }
      case "matrix": {
        const mapVal = (val && typeof val === "object" && !Array.isArray(val) ? val : {}) as Record<string, string>;
        return (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="p-2 text-left font-medium">{t("评估维度")}</th>
                  {(q.matrixCols ?? []).map((col) => (
                    <th key={col} className="p-2 text-center font-medium">{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(q.matrixRows ?? []).map((row) => (
                  <tr key={row} className="border-b">
                    <td className="p-2 font-medium">{row}</td>
                    {(q.matrixCols ?? []).map((col) => (
                      <td key={col} className="p-2 text-center">
                        <input
                          type="radio"
                          name={`${q.id}:${row}`}
                          checked={mapVal[row] === col}
                          data-public-matrix={`${q.id}:${row}:${col}`}
                          onChange={() => setAnswer(q.id, { ...mapVal, [row]: col })}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
      case "ranking": {
        const order = Array.isArray(val) && val.length ? (val as string[]) : [...(q.options ?? [])];
        const swap = (i: number, j: number) => {
          if (j < 0 || j >= order.length) return;
          const next = [...order];
          [next[i], next[j]] = [next[j], next[i]];
          setAnswer(q.id, next);
        };
        return (
          <div className="space-y-1.5">
            {order.map((opt, oi) => (
              <div key={opt} className="flex items-center justify-between rounded-lg border bg-background px-3 py-2 text-[14px]">
                <span>
                  <strong className="mr-2 text-violet-600">#{oi + 1}</strong>
                  {opt}
                </span>
                <span className="flex items-center gap-1">
                  <button type="button" disabled={oi === 0} onClick={() => swap(oi, oi - 1)} className="grid size-7 place-items-center rounded border hover:bg-hover disabled:opacity-30"><ArrowUp size={13} /></button>
                  <button type="button" disabled={oi === order.length - 1} onClick={() => swap(oi, oi + 1)} className="grid size-7 place-items-center rounded border hover:bg-hover disabled:opacity-30"><ArrowDown size={13} /></button>
                </span>
              </div>
            ))}
          </div>
        );
      }
      case "signature":
        return <SignaturePad value={typeof val === "string" ? val : ""} onChange={(url) => setAnswer(q.id, url)} />;
      default:
        return (
          <textarea
            rows={3}
            value={typeof val === "string" ? val : ""}
            onChange={(e) => setAnswer(q.id, e.target.value)}
            placeholder={t("请输入您的回答…")}
            data-public-text={q.id}
            className="w-full resize-none rounded-lg border bg-background p-3 text-[14px] outline-none focus:border-violet-500"
          />
        );
    }
  };

  return (
    <div className="min-h-full bg-[#F5F6F7] px-4 py-8 dark:bg-background" data-public-survey-page>
      <form onSubmit={handleSubmit} className="mx-auto max-w-[680px] space-y-4">
        <div className="rounded-xl border border-t-4 border-t-violet-600 bg-surface p-6 shadow-xs">
          <h1 className="text-[22px] font-bold text-foreground">{sv.title}</h1>
          {sv.description && <p className="mt-2 whitespace-pre-wrap text-[14px] text-muted-foreground">{sv.description}</p>}
          <div className="mt-4">
            <input
              type="text"
              value={respondentName}
              onChange={(e) => setRespondentName(e.target.value)}
              placeholder={t("您的称呼（选填）")}
              data-public-respondent-name
              className="h-9 w-full max-w-xs rounded-md border bg-background px-3 text-[13px] outline-none focus:border-violet-500"
            />
          </div>
        </div>

        {visibleQuestions.map((q, idx) => (
          <div key={q.id} data-public-question={q.id} className="space-y-3 rounded-xl border bg-surface p-6 shadow-xs">
            <div className="text-[15px] font-semibold text-foreground">
              <span className="mr-1.5 text-violet-600">{idx + 1}.</span>
              {q.title}
              {q.required && <span className="ml-1 text-rose-500">*</span>}
            </div>
            {q.description && <p className="text-[13px] text-muted-foreground">{q.description}</p>}
            {renderQuestionControl(q)}
          </div>
        ))}

        {error && <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-[13px] text-destructive">{error}</p>}

        <div className="flex justify-center pt-2">
          <Button
            type="submit"
            disabled={submitting}
            data-public-survey-submit
            className="h-11 w-full max-w-xs bg-violet-600 text-[15px] font-medium text-white hover:bg-violet-700"
          >
            {submitting ? t("正在提交…") : t("提交问卷")}
          </Button>
        </div>
      </form>
    </div>
  );
}
