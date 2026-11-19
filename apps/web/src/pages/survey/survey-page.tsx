import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BarChart3,
  Check,
  ClipboardList,
  Copy,
  Download,
  ExternalLink,
  GitBranch,
  Globe,
  PauseCircle,
  PlayCircle,
  Plus,
  Save,
  Star,
  Trash2,
} from "lucide-react";
import {
  docsApi,
  surveysApi,
  type SurveyQuestion,
  type SurveyQuestionType,
  type SurveySkipRule,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { buildSurveyCsv } from "./skip-logic";

const QUESTION_TYPES: { type: SurveyQuestionType; label: string; desc: string }[] = [
  { type: "single", label: "单选题", desc: "支持配置跳题逻辑" },
  { type: "multi", label: "多选题", desc: "多项勾选" },
  { type: "text", label: "简答题", desc: "自由文本输入" },
  { type: "rating", label: "评分题", desc: "星级满意度评分" },
  { type: "matrix", label: "矩阵量表", desc: "多维行×列评估" },
  { type: "ranking", label: "排序题", desc: "按优先级排序" },
  { type: "signature", label: "电子签名", desc: "手写画布签字确认" },
];

const STATUS_BADGE = {
  draft: { label: "草稿", cls: "bg-muted text-muted-foreground" },
  published: { label: "收集中", cls: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300" },
  closed: { label: "已停止", cls: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300" },
} as const;

function makeQuestion(type: SurveyQuestionType, count: number): SurveyQuestion {
  const id = `q_${Date.now().toString(36)}_${count + 1}`;
  switch (type) {
    case "single":
      return { id, type, title: "未命名单选题", required: true, options: ["选项 1", "选项 2", "选项 3"] };
    case "multi":
      return { id, type, title: "未命名多选题", required: false, options: ["选项 A", "选项 B", "选项 C"] };
    case "rating":
      return { id, type, title: "请为本次体验打分", required: true, maxRating: 5 };
    case "matrix":
      return {
        id,
        type,
        title: "请评价以下各维度表现",
        required: false,
        matrixRows: ["易用性", "响应速度"],
        matrixCols: ["非常满意", "满意", "一般", "不满意"],
      };
    case "ranking":
      return { id, type, title: "请按重要程度从高到低排序", required: false, options: ["协作效率", "排版体验", "安全权限"] };
    case "signature":
      return { id, type, title: "请手写签名确认", required: true };
    default:
      return { id, type: "text", title: "未命名简答题", required: false };
  }
}

export function SurveyPage({ surveyId }: { surveyId: number }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"design" | "publish" | "stats">("design");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [questions, setQuestions] = useState<SurveyQuestion[]>([]);
  const [allowAnonymous, setAllowAnonymous] = useState(true);
  const [maxResponses, setMaxResponses] = useState(0);
  const [revision, setRevision] = useState(1);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const detailQuery = useQuery({
    queryKey: ["survey", surveyId],
    queryFn: () => surveysApi.get(surveyId),
  });

  const statsQuery = useQuery({
    queryKey: ["survey-stats", surveyId],
    queryFn: () => surveysApi.stats(surveyId),
    enabled: tab === "stats",
  });

  const sv = detailQuery.data?.survey;
  const canEdit = detailQuery.data?.role === "edit" || detailQuery.data?.role === "manage";

  useEffect(() => {
    if (!detailQuery.data || dirty) return;
    setTitle(detailQuery.data.title || "未命名问卷");
    setDescription(detailQuery.data.survey.description || "");
    setQuestions(detailQuery.data.survey.questions || []);
    setAllowAnonymous(detailQuery.data.survey.allowAnonymous);
    setMaxResponses(detailQuery.data.survey.maxResponses);
    setRevision(detailQuery.data.survey.revision);
  }, [detailQuery.data, dirty]);

  const publicUrl = useMemo(() => {
    if (!sv?.publicToken) return "";
    return `${window.location.origin}${window.location.pathname}#/q/${sv.publicToken}`;
  }, [sv?.publicToken]);

  const handleSave = async () => {
    if (!canEdit || saving) return;
    setSaving(true);
    setNotice(null);
    try {
      const trimmedTitle = title.trim() || "未命名问卷";
      if (detailQuery.data && trimmedTitle !== detailQuery.data.title) {
        await docsApi.rename(surveyId, trimmedTitle);
        void qc.invalidateQueries({ queryKey: ["docs"] });
      }
      const saved = await surveysApi.save(surveyId, {
        description,
        questions,
        allowAnonymous,
        maxResponses,
        expectedRevision: revision,
      });
      setRevision(saved.revision);
      setDirty(false);
      await qc.invalidateQueries({ queryKey: ["survey", surveyId] });
      setNotice({ ok: true, text: "问卷已保存" });
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : "保存失败" });
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange = async (nextStatus: "draft" | "published" | "closed") => {
    if (!canEdit || saving) return;
    setSaving(true);
    setNotice(null);
    try {
      if (dirty) {
        const saved = await surveysApi.save(surveyId, {
          description,
          questions,
          allowAnonymous,
          maxResponses,
          expectedRevision: revision,
        });
        setRevision(saved.revision);
        setDirty(false);
      }
      const updated = await surveysApi.setStatus(surveyId, {
        status: nextStatus,
        allowAnonymous,
        maxResponses,
      });
      setRevision(updated.revision);
      await qc.invalidateQueries({ queryKey: ["survey", surveyId] });
      setNotice({
        ok: true,
        text: nextStatus === "published" ? "问卷已发布并开始收集答卷" : nextStatus === "closed" ? "已停止收集答卷" : "已切回草稿状态",
      });
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : "切换状态失败" });
    } finally {
      setSaving(false);
    }
  };

  const updateQuestion = (index: number, patch: Partial<SurveyQuestion>) => {
    setQuestions((prev) => prev.map((q, i) => (i === index ? { ...q, ...patch } : q)));
    setDirty(true);
  };

  const moveQuestion = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= questions.length) return;
    setQuestions((prev) => {
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    setDirty(true);
  };

  const removeQuestion = (index: number) => {
    const removedId = questions[index]?.id;
    setQuestions((prev) =>
      prev
        .filter((_, i) => i !== index)
        .map((q) =>
          q.skipRules?.length
            ? { ...q, skipRules: q.skipRules.filter((r) => r.jumpToQuestionId !== removedId) }
            : q,
        ),
    );
    setDirty(true);
  };

  const addQuestion = (type: SurveyQuestionType) => {
    setQuestions((prev) => [...prev, makeQuestion(type, prev.length)]);
    setDirty(true);
  };

  const handleExportCsv = () => {
    if (!statsQuery.data) return;
    const csv = "\uFEFF" + buildSurveyCsv(questions, statsQuery.data.responses);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.trim() || "survey"}-responses.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (detailQuery.isPending) {
    return <div className="grid h-full flex-1 place-items-center text-sm text-muted-foreground">正在加载问卷…</div>;
  }
  if (detailQuery.isError || !sv) {
    return (
      <div className="grid h-full flex-1 place-items-center p-6 text-center text-sm text-destructive">
        无法加载问卷，请确认访问权限或刷新重试。
      </div>
    );
  }

  const badge = STATUS_BADGE[sv.status];

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-[#F5F6F7] dark:bg-background" data-survey-page>
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b bg-surface px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <a
            href="#/"
            className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground"
            title="返回主页"
          >
            <ArrowLeft size={16} />
          </a>
          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-violet-600 text-white">
            <ClipboardList size={15} />
          </span>
          <input
            type="text"
            value={title}
            disabled={!canEdit}
            onChange={(e) => { setTitle(e.target.value); setDirty(true); }}
            data-survey-title-input
            className="min-w-[140px] max-w-[320px] truncate rounded bg-transparent px-1.5 py-0.5 text-[15px] font-semibold text-foreground outline-none focus:bg-hover"
          />
          <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium", badge.cls)} data-survey-status={sv.status}>
            {badge.label}
          </span>
        </div>

        <nav className="flex items-center gap-1 rounded-lg bg-muted/60 p-1">
          {([
            ["design", "编辑问卷"],
            ["publish", "发布与回收"],
            ["stats", `结果统计 (${detailQuery.data.responseCount})`],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              data-survey-tab={key}
              className={cn(
                "rounded-md px-3 py-1 text-[13px] transition-colors",
                tab === key ? "bg-surface font-medium text-foreground shadow-2xs" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          {canEdit && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={saving}
              onClick={() => void handleSave()}
              data-save-survey
              className="h-8 gap-1.5 text-[13px]"
            >
              <Save size={14} />{dirty ? "保存更改" : "已保存"}
            </Button>
          )}
          {canEdit && sv.status !== "published" ? (
            <Button
              type="button"
              size="sm"
              disabled={saving}
              onClick={() => void handleStatusChange("published")}
              data-publish-survey
              className="h-8 gap-1.5 bg-violet-600 text-[13px] text-white hover:bg-violet-700"
            >
              <PlayCircle size={14} />发布问卷
            </Button>
          ) : canEdit && sv.status === "published" ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={saving}
              onClick={() => void handleStatusChange("closed")}
              data-close-survey
              className="h-8 gap-1.5 border-rose-200 text-[13px] text-rose-700 hover:bg-rose-50"
            >
              <PauseCircle size={14} />停止收集
            </Button>
          ) : null}
        </div>
      </header>

      {notice && (
        <div
          role={notice.ok ? "status" : "alert"}
          className={cn(
            "border-b px-5 py-2 text-[13px]",
            notice.ok ? "bg-emerald-50/80 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200" : "bg-rose-50 text-destructive",
          )}
        >
          {notice.text}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8">
        {tab === "design" && (
          <div className="mx-auto grid max-w-[1040px] gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
            <aside className="h-fit rounded-xl border bg-surface p-3.5 shadow-2xs">
              <h2 className="mb-2.5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                添加题目
              </h2>
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-1">
                {QUESTION_TYPES.map((item) => (
                  <button
                    key={item.type}
                    type="button"
                    disabled={!canEdit}
                    onClick={() => addQuestion(item.type)}
                    data-add-question={item.type}
                    className="flex flex-col rounded-lg border border-transparent bg-muted/40 px-3 py-2 text-left transition-colors hover:border-violet-200 hover:bg-violet-50/50 disabled:opacity-50 dark:hover:bg-violet-950/30"
                  >
                    <span className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
                      <Plus size={13} className="text-violet-600" />
                      {item.label}
                    </span>
                    <span className="text-[11px] text-muted-foreground">{item.desc}</span>
                  </button>
                ))}
              </div>
            </aside>

            <main className="space-y-4">
              <div className="rounded-xl border border-t-4 border-t-violet-600 bg-surface p-5 shadow-2xs">
                <input
                  type="text"
                  value={title}
                  disabled={!canEdit}
                  onChange={(e) => { setTitle(e.target.value); setDirty(true); }}
                  placeholder="问卷标题"
                  className="mb-2 w-full bg-transparent text-[22px] font-bold text-foreground outline-none"
                />
                <textarea
                  rows={2}
                  value={description}
                  disabled={!canEdit}
                  onChange={(e) => { setDescription(e.target.value); setDirty(true); }}
                  placeholder="输入问卷欢迎语与填写说明…"
                  data-survey-desc-input
                  className="w-full resize-none rounded-md bg-transparent text-[14px] text-muted-foreground outline-none focus:bg-muted/30"
                />
              </div>

              {questions.map((q, idx) => {
                const laterQuestions = questions.slice(idx + 1);
                return (
                  <div
                    key={q.id}
                    data-question-card={q.id}
                    className="space-y-3 rounded-xl border bg-surface p-5 shadow-2xs"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-violet-100 text-[12px] font-semibold text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                          {idx + 1}
                        </span>
                        <input
                          type="text"
                          value={q.title}
                          disabled={!canEdit}
                          onChange={(e) => updateQuestion(idx, { title: e.target.value })}
                          data-question-title={q.id}
                          className="min-w-0 flex-1 rounded bg-transparent px-1.5 py-0.5 text-[15px] font-medium text-foreground outline-none focus:bg-muted/40"
                        />
                        <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                          {QUESTION_TYPES.find((t) => t.type === q.type)?.label ?? q.type}
                        </span>
                      </div>

                      {canEdit && (
                        <div className="flex shrink-0 items-center gap-1">
                          <label className="mr-2 flex items-center gap-1 text-[12px] text-muted-foreground">
                            <input
                              type="checkbox"
                              checked={q.required}
                              onChange={(e) => updateQuestion(idx, { required: e.target.checked })}
                            />
                            必填
                          </label>
                          <button type="button" onClick={() => moveQuestion(idx, -1)} disabled={idx === 0} className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-hover disabled:opacity-30"><ArrowUp size={14} /></button>
                          <button type="button" onClick={() => moveQuestion(idx, 1)} disabled={idx === questions.length - 1} className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-hover disabled:opacity-30"><ArrowDown size={14} /></button>
                          <button type="button" onClick={() => removeQuestion(idx)} className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-hover hover:text-destructive"><Trash2 size={14} /></button>
                        </div>
                      )}
                    </div>

                    {(q.type === "single" || q.type === "multi" || q.type === "ranking") && (
                      <div className="space-y-2 pl-8">
                        {(q.options ?? []).map((opt, oi) => (
                          <div key={oi} className="flex items-center gap-2">
                            <span className="text-[12px] text-subtle">{q.type === "ranking" ? `${oi + 1}.` : "•"}</span>
                            <input
                              type="text"
                              value={opt}
                              disabled={!canEdit}
                              onChange={(e) => {
                                const next = [...(q.options ?? [])];
                                next[oi] = e.target.value;
                                updateQuestion(idx, { options: next });
                              }}
                              className="h-8 flex-1 rounded border bg-background px-2.5 text-[13px] outline-none focus:border-violet-400"
                            />
                            {canEdit && (q.options?.length ?? 0) > 1 && (
                              <button
                                type="button"
                                onClick={() => updateQuestion(idx, { options: (q.options ?? []).filter((_, k) => k !== oi) })}
                                className="text-muted-foreground hover:text-destructive"
                              >
                                <Trash2 size={13} />
                              </button>
                            )}
                          </div>
                        ))}
                        {canEdit && (
                          <button
                            type="button"
                            onClick={() => updateQuestion(idx, { options: [...(q.options ?? []), `选项 ${(q.options?.length ?? 0) + 1}`] })}
                            className="inline-flex items-center gap-1 text-[12px] text-violet-600 hover:underline"
                          >
                            <Plus size={12} />添加选项
                          </button>
                        )}
                      </div>
                    )}

                    {q.type === "rating" && (
                      <div className="flex items-center gap-3 pl-8 text-[13px] text-muted-foreground">
                        <span>最高分值：</span>
                        <select
                          value={q.maxRating ?? 5}
                          disabled={!canEdit}
                          onChange={(e) => updateQuestion(idx, { maxRating: Number(e.target.value) })}
                          className="h-8 rounded border bg-background px-2 text-foreground"
                        >
                          {[3, 5, 7, 10].map((n) => <option key={n} value={n}>{n} 分制</option>)}
                        </select>
                        <span className="flex items-center gap-0.5 text-amber-400">
                          {Array.from({ length: Math.min(5, q.maxRating ?? 5) }).map((_, s) => <Star key={s} size={15} fill="currentColor" />)}
                        </span>
                      </div>
                    )}

                    {q.type === "matrix" && (
                      <div className="grid gap-3 pl-8 sm:grid-cols-2">
                        <div className="space-y-1.5">
                          <label className="text-[12px] font-medium text-muted-foreground">行维度（每行一个）</label>
                          <textarea
                            rows={3}
                            disabled={!canEdit}
                            value={(q.matrixRows ?? []).join("\n")}
                            onChange={(e) => updateQuestion(idx, { matrixRows: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })}
                            className="w-full rounded border bg-background p-2 text-[12px]"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-[12px] font-medium text-muted-foreground">列量表（每行一个）</label>
                          <textarea
                            rows={3}
                            disabled={!canEdit}
                            value={(q.matrixCols ?? []).join("\n")}
                            onChange={(e) => updateQuestion(idx, { matrixCols: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })}
                            className="w-full rounded border bg-background p-2 text-[12px]"
                          />
                        </div>
                      </div>
                    )}

                    {q.type === "signature" && (
                      <div className="pl-8 text-[12px] text-muted-foreground">
                        填写页将提供手写签名画布并记录电子签名图像。
                      </div>
                    )}

                    {(q.type === "single" || q.type === "multi") && (
                      <div className="rounded-lg border border-dashed bg-muted/20 p-3 pl-8" data-skip-logic-section={q.id}>
                        <div className="mb-2 flex items-center justify-between">
                          <span className="flex items-center gap-1.5 text-[12px] font-medium text-violet-700 dark:text-violet-300">
                            <GitBranch size={13} />跳题逻辑（条件跳转）
                          </span>
                          {canEdit && (q.options?.length ?? 0) > 0 && (
                            <button
                              type="button"
                              data-add-skip-rule={q.id}
                              onClick={() => {
                                const nextRule: SurveySkipRule = {
                                  whenOption: q.options?.[0] ?? "",
                                  jumpToQuestionId: laterQuestions[0]?.id ?? "__END__",
                                };
                                updateQuestion(idx, { skipRules: [...(q.skipRules ?? []), nextRule] });
                              }}
                              className="text-[12px] text-violet-600 hover:underline"
                            >
                              + 添加跳转规则
                            </button>
                          )}
                        </div>
                        {(q.skipRules ?? []).length === 0 ? (
                          <p className="text-[11px] text-muted-foreground">未配置跳题逻辑，将按顺序展示下一题。</p>
                        ) : (
                          <div className="space-y-1.5">
                            {(q.skipRules ?? []).map((rule, ri) => (
                              <div key={ri} className="flex flex-wrap items-center gap-2 text-[12px]">
                                <span>当选择</span>
                                <select
                                  value={rule.whenOption}
                                  disabled={!canEdit}
                                  onChange={(e) => {
                                    const rules = [...(q.skipRules ?? [])];
                                    rules[ri] = { ...rule, whenOption: e.target.value };
                                    updateQuestion(idx, { skipRules: rules });
                                  }}
                                  className="h-7 rounded border bg-surface px-2"
                                >
                                  {(q.options ?? []).map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                                </select>
                                <span>时，跳转至</span>
                                <select
                                  value={rule.jumpToQuestionId}
                                  disabled={!canEdit}
                                  onChange={(e) => {
                                    const rules = [...(q.skipRules ?? [])];
                                    rules[ri] = { ...rule, jumpToQuestionId: e.target.value };
                                    updateQuestion(idx, { skipRules: rules });
                                  }}
                                  className="h-7 rounded border bg-surface px-2"
                                >
                                  {laterQuestions.map((tq, ti) => (
                                    <option key={tq.id} value={tq.id}>
                                      第 {idx + 2 + ti} 题：{tq.title.slice(0, 18)}
                                    </option>
                                  ))}
                                  <option value="__END__">直接结束并提交</option>
                                </select>
                                {canEdit && (
                                  <button
                                    type="button"
                                    onClick={() => updateQuestion(idx, { skipRules: (q.skipRules ?? []).filter((_, k) => k !== ri) })}
                                    className="text-muted-foreground hover:text-destructive"
                                  >
                                    <Trash2 size={12} />
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </main>
          </div>
        )}

        {tab === "publish" && (
          <div className="mx-auto max-w-[680px] space-y-4">
            <div className="rounded-xl border bg-surface p-6 shadow-2xs">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h2 className="text-[16px] font-semibold text-foreground">公开填写与回收控制</h2>
                  <p className="text-[13px] text-muted-foreground">发布后即可通过公开链接邀请内外部受访者填写。</p>
                </div>
                <span className={cn("rounded-full border px-2.5 py-1 text-[12px] font-medium", badge.cls)}>
                  {badge.label}
                </span>
              </div>

              {sv.publicToken && sv.status === "published" ? (
                <div className="mb-5 space-y-2 rounded-lg border border-violet-200 bg-violet-50/40 p-4 dark:border-violet-900 dark:bg-violet-950/20">
                  <div className="flex items-center gap-1.5 text-[12px] font-medium text-violet-700 dark:text-violet-300">
                    <Globe size={14} />公开填写链接
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      readOnly
                      value={publicUrl}
                      data-public-survey-url
                      className="h-9 flex-1 rounded-md border bg-surface px-3 text-[13px] text-foreground"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        void navigator.clipboard?.writeText(publicUrl).catch(() => {});
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1800);
                      }}
                      className="h-9 gap-1.5"
                    >
                      {copied ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
                      {copied ? "已复制" : "复制"}
                    </Button>
                    <a
                      href={`#/q/${sv.publicToken}`}
                      data-open-public-survey
                      className="inline-flex h-9 items-center gap-1 rounded-md bg-violet-600 px-3 text-[13px] font-medium text-white hover:bg-violet-700"
                    >
                      打开填写页<ExternalLink size={13} />
                    </a>
                  </div>
                </div>
              ) : (
                <div className="mb-5 rounded-lg border border-dashed p-4 text-[13px] text-muted-foreground">
                  {sv.status === "closed" ? "当前问卷已停止收集，重新点击「发布问卷」即可恢复回收。" : "点击右上角「发布问卷」生成公开填写链接。"}
                </div>
              )}

              <div className="space-y-4 border-t pt-4 text-[13px]">
                <label className="flex items-center justify-between gap-4">
                  <span>
                    <span className="block font-medium text-foreground">允许匿名填写</span>
                    <span className="text-[12px] text-muted-foreground">关闭后受访者需登录账号方可提交答卷</span>
                  </span>
                  <input
                    type="checkbox"
                    disabled={!canEdit}
                    checked={allowAnonymous}
                    onChange={(e) => { setAllowAnonymous(e.target.checked); setDirty(true); }}
                    className="size-4"
                  />
                </label>

                <label className="flex items-center justify-between gap-4">
                  <span>
                    <span className="block font-medium text-foreground">回收份数上限</span>
                    <span className="text-[12px] text-muted-foreground">填 0 表示不限制回收份数</span>
                  </span>
                  <input
                    type="number"
                    min={0}
                    disabled={!canEdit}
                    value={maxResponses}
                    onChange={(e) => { setMaxResponses(Math.max(0, Number(e.target.value) || 0)); setDirty(true); }}
                    className="h-8 w-28 rounded-md border bg-background px-2.5 text-right"
                  />
                </label>
              </div>
            </div>
          </div>
        )}

        {tab === "stats" && (
          <div className="mx-auto max-w-[960px] space-y-5" data-survey-stats>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="rounded-xl border bg-surface p-4 shadow-2xs">
                <div className="text-[12px] text-muted-foreground">总回收份数</div>
                <div className="mt-1 text-[28px] font-bold text-violet-600" data-survey-total-responses>
                  {statsQuery.data?.totalResponses ?? detailQuery.data.responseCount}
                </div>
              </div>
              <div className="rounded-xl border bg-surface p-4 shadow-2xs">
                <div className="text-[12px] text-muted-foreground">题目总数</div>
                <div className="mt-1 text-[28px] font-bold text-foreground">{questions.length}</div>
              </div>
              <div className="flex items-center justify-between rounded-xl border bg-surface p-4 shadow-2xs">
                <div>
                  <div className="text-[12px] text-muted-foreground">数据导出</div>
                  <div className="mt-1 text-[13px] font-medium text-foreground">原始答卷明细表</div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!statsQuery.data?.responses.length}
                  onClick={handleExportCsv}
                  data-export-survey-csv
                  className="gap-1.5"
                >
                  <Download size={14} />导出 CSV
                </Button>
              </div>
            </div>

            {statsQuery.isPending ? (
              <div className="rounded-xl border bg-surface p-8 text-center text-[13px] text-muted-foreground">正在汇总可视化统计结果…</div>
            ) : (
              <>
                {(statsQuery.data?.questionStats ?? []).map((qs, qi) => (
                  <div key={qs.questionId} className="space-y-3 rounded-xl border bg-surface p-5 shadow-2xs" data-stat-card={qs.questionId}>
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
                        <BarChart3 size={16} className="text-violet-600" />
                        <span>第 {qi + 1} 题：{qs.title}</span>
                      </h3>
                      <span className="text-[12px] text-muted-foreground">有效作答：{qs.answered} 份</span>
                    </div>

                    {(qs.type === "single" || qs.type === "multi") && qs.optionCounts && (
                      <div className="space-y-2">
                        {Object.entries(qs.optionCounts).map(([opt, count]) => {
                          const pct = qs.answered > 0 ? Math.round((count / qs.answered) * 100) : 0;
                          return (
                            <div key={opt} className="space-y-1 text-[13px]">
                              <div className="flex justify-between">
                                <span className="text-foreground">{opt}</span>
                                <span className="font-medium text-muted-foreground">{count} 票 ({pct}%)</span>
                              </div>
                              <div className="h-2.5 overflow-hidden rounded-full bg-muted">
                                <div className="h-full rounded-full bg-violet-500 transition-all" style={{ width: `${pct}%` }} />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {qs.type === "rating" && (
                      <div className="flex flex-wrap items-center gap-6">
                        <div className="rounded-lg bg-amber-50/70 px-4 py-2 text-center dark:bg-amber-950/30">
                          <div className="text-[11px] text-amber-700 dark:text-amber-300">平均分</div>
                          <div className="text-[24px] font-bold text-amber-600">{qs.average ?? 0}</div>
                        </div>
                        <div className="flex flex-1 flex-wrap gap-2 text-[12px]">
                          {Object.entries(qs.ratingDist ?? {}).map(([score, cnt]) => (
                            <span key={score} className="rounded-md border px-2.5 py-1">
                              {score} 分：<strong>{cnt}</strong> 人
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {qs.type === "matrix" && qs.matrixCounts && (
                      <div className="overflow-x-auto">
                        <table className="w-full border-collapse text-[12px]">
                          <thead>
                            <tr className="border-b bg-muted/40">
                              <th className="p-2 text-left font-medium">行维度 \ 列选项</th>
                              {Object.keys(Object.values(qs.matrixCounts)[0] ?? {}).map((col) => (
                                <th key={col} className="p-2 text-center font-medium">{col}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {Object.entries(qs.matrixCounts).map(([row, cols]) => (
                              <tr key={row} className="border-b">
                                <td className="p-2 font-medium">{row}</td>
                                {Object.entries(cols).map(([col, cnt]) => (
                                  <td key={col} className="p-2 text-center">{cnt}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {qs.type === "ranking" && qs.rankAvg && (
                      <div className="space-y-1.5 text-[13px]">
                        {Object.entries(qs.rankAvg)
                          .sort((a, b) => a[1] - b[1])
                          .map(([opt, avg], ri) => (
                            <div key={opt} className="flex items-center justify-between rounded bg-muted/30 px-3 py-1.5">
                              <span>
                                <strong className="mr-2 text-violet-600">#{ri + 1}</strong>
                                {opt}
                              </span>
                              <span className="text-[12px] text-muted-foreground">平均排名：{avg}</span>
                            </div>
                          ))}
                      </div>
                    )}

                    {qs.type === "signature" && (
                      <div className="flex flex-wrap gap-3">
                        {(qs.textSamples ?? []).map((src, si) => (
                          <img key={si} src={src} alt={`签名 ${si + 1}`} className="h-16 rounded border bg-white object-contain p-1" />
                        ))}
                        {!(qs.textSamples?.length) && <span className="text-[12px] text-muted-foreground">暂无签名记录</span>}
                      </div>
                    )}

                    {qs.type === "text" && (
                      <ul className="space-y-1.5 text-[13px]">
                        {(qs.textSamples ?? []).map((sample, si) => (
                          <li key={si} className="rounded bg-muted/30 px-3 py-1.5 text-foreground">{sample}</li>
                        ))}
                        {!(qs.textSamples?.length) && <li className="text-[12px] text-muted-foreground">暂无文本作答</li>}
                      </ul>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
