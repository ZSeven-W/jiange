import { useLayoutEffect, useRef, useState } from "react";
import { ApiError, baseApi } from "@/lib/api";
import { refreshWrites, useWriteLedger, type WriteLedger } from "./writeSafety";

export function importFailureMessage(error: unknown): string {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
    if (error.status === 409) return "表格或权限已变化，未导入数据，请检查后重新选择文件。";
    if (error.status === 401 || error.status === 403 || error.status === 404) return "当前无权导入或登录已失效，未导入数据。";
    return `未导入数据：${error.message || "文件内容无效"}`;
  }
  return "无法确认导入是否完成，请先检查记录，避免重复导入。";
}

export function importResultMessage(result: { imported: number; errors: { row: number; err: string }[] }): string {
  if (!result.errors.length) return `已导入 ${result.imported} 条记录。`;
  return `已导入 ${result.imported} 条记录，跳过 ${result.errors.length} 行：${result.errors.slice(0, 5).map((item) => `第 ${item.row} 行 ${item.err}`).join("；")}${result.errors.length > 5 ? "等" : ""}`;
}

/** Keep the session ledger accurate even if the chooser's component unmounts. */
export async function executeCsvImport({ file, ledger, valid, send, onRefresh, onMessage }: {
  file: Pick<File, "name" | "size" | "arrayBuffer">;
  ledger: WriteLedger;
  valid: () => boolean;
  send: (csv: string) => ReturnType<typeof baseApi.importCSV>;
  onRefresh: () => Promise<unknown>;
  onMessage: (message: string) => void;
}): Promise<void> {
  if (ledger.hasCellWrites() || ledger.blocked("record:create")) return;
  if (file.size > (1 << 20)) { if (valid()) onMessage("CSV 文件超过 1 MiB，请拆分后再导入。"); return; }
  const op = ledger.begin("导入 CSV", file.name, "batch");
  if (op === null) return;
  let requestStarted = false;
  try {
    const csv = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
    // No request was sent: release the old Base's ledger even after unmount.
    if (!valid()) { ledger.complete(op); return; }
    requestStarted = true;
    const result = await send(csv);
    ledger.complete(op);
    if (valid()) onMessage(importResultMessage(result));
  } catch (error) {
    if (!requestStarted || (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429)) ledger.complete(op);
    else ledger.fail(op, "无法确认导入是否完成，请先核对记录，勿直接重复导入。");
    if (valid()) onMessage(requestStarted ? importFailureMessage(error) : "无法读取文件，请选择 UTF-8 编码的 CSV 文件。");
  } finally {
    if (requestStarted) refreshWrites(onRefresh);
  }
}

/** Import is never automatically retried: an interrupted response may follow a committed write. */
export function CsvImport({ baseId, onRefresh }: { baseId: number; onRefresh: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const { ledger } = useWriteLedger(baseId);
  const identity = useRef({ baseId, alive: true });
  const pending = useRef(false);
  identity.current.baseId = baseId;
  useLayoutEffect(() => {
    identity.current.alive = true;
    return () => { identity.current.alive = false; };
  }, []);
  const valid = (original: number) => identity.current.alive && identity.current.baseId === original;

  const importFile = async (file: File) => {
    if (pending.current) return;
    const original = baseId;
    pending.current = true; setBusy(true); setMessage(null);
    try {
      await executeCsvImport({ file, ledger, valid: () => valid(original), send: (csv) => baseApi.importCSV(original, csv), onRefresh, onMessage: setMessage });
    } finally {
      pending.current = false;
      if (valid(original)) setBusy(false);
    }
  };
  const disabled = busy || ledger.blocked("batch") || ledger.blocked("record:create") || ledger.hasCellWrites();
  return <>
    <label className={`rounded-md px-2 py-1 ${disabled ? "cursor-not-allowed text-subtle" : "cursor-pointer text-muted-foreground hover:bg-hover hover:text-foreground"}`} data-import-csv>
      {busy ? "正在导入…" : "导入 CSV"}
      <input type="file" accept=".csv,text/csv" disabled={disabled} className="sr-only" onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (file) void importFile(file);
      }} />
    </label>
    {message && <span role="status" className="max-w-[420px] whitespace-normal text-xs text-muted-foreground">{message}</span>}
  </>;
}
