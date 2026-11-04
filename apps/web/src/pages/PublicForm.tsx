import { useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

interface FormFieldDef {
  id: number;
  name: string;
  type: string;
  options?: string[];
}

/** Public response form (no login): /api/forms/{baseId}/{viewId}. */
export function PublicForm({ baseId, viewId }: { baseId: number; viewId: number }) {
  const [def, setDef] = useState<{ title: string; desc: string; fields: FormFieldDef[] } | null>(null);
  const [err, setErr] = useState("");
  const [values, setValues] = useState<Record<number, string>>({});
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!def && !err) {
    fetch(`/api/forms/${baseId}/${viewId}`)
      .then(async (r) => {
        if (!r.ok) throw new Error("表单不存在或已关闭");
        setDef(await r.json());
      })
      .catch((e) => setErr(String(e.message || e)));
  }

  const submit = async () => {
    if (busy || !def) return;
    setBusy(true);
    setErr("");
    try {
      const cells: Record<string, unknown> = {};
      for (const f of def.fields) {
        const v = values[f.id]?.trim();
        if (!v) continue;
        cells[f.id] = f.type === "number" ? Number(v) : v;
      }
      const res = await fetch(`/api/forms/${baseId}/${viewId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cells }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message ?? "提交失败");
      }
      setDone(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-full place-items-center bg-sidebar/50 p-6" data-public-form>
      <div className="w-full max-w-md rounded-2xl border bg-white p-8 shadow-sm">
        {err && !def && <p className="text-center text-[14px] text-destructive">{err}</p>}
        {done ? (
          <div className="py-10 text-center" data-form-done>
            <div className="mx-auto mb-3 grid size-12 place-items-center rounded-full bg-[#D9F5D6] text-[22px] text-[#237B19]">✓</div>
            <p className="text-[16px] font-medium">提交成功</p>
            <p className="mt-1 text-[13px] text-muted-foreground">感谢你的反馈！</p>
          </div>
        ) : (
          def && (
            <>
              <h1 className="text-[20px] font-semibold">{def.title || "表单"}</h1>
              {def.desc && <p className="mb-5 mt-1 text-[13px] text-muted-foreground">{def.desc}</p>}
              <div className="space-y-4">
                {def.fields.map((f) => (
                  <label key={f.id} className="block">
                    <span className="mb-1 block text-[13px] font-medium">{f.name}</span>
                    {f.type === "select" ? (
                      <select
                        className="h-9 w-full rounded-md border bg-white px-2 text-[14px] outline-none focus:border-primary"
                        value={values[f.id] ?? ""}
                        onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
                      >
                        <option value="">请选择</option>
                        {(f.options ?? []).map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className={cn("h-9 w-full rounded-md border px-2.5 text-[14px] outline-none focus:border-primary")}
                        type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}
                        value={values[f.id] ?? ""}
                        onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
                      />
                    )}
                  </label>
                ))}
              </div>
              {err && <p className="mt-3 text-[13px] text-destructive">{err}</p>}
              <button className="mt-6 h-10 w-full rounded-md bg-primary text-[14px] font-medium text-white hover:opacity-90 disabled:opacity-50" disabled={busy} onClick={() => void submit()} data-form-submit>
                {busy ? "提交中…" : "提交"}
              </button>
              <p className="mt-3 text-center text-[12px] text-subtle">由 Jiange 表单收集</p>
            </>
          )
        )}
      </div>
    </div>
  );
}

export const _publicFormUsesApi = api;
