import { ApiError } from "@/lib/api";

/** Hide cached records for both authorization failures and transient errors. */
export function baseLoadError(error: unknown): string {
  return error instanceof ApiError && [401, 403, 404].includes(error.status)
    ? "多维表格不存在或无权访问"
    : "暂时无法加载多维表格，请检查网络";
}
