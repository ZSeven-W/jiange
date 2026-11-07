import type { QueryClient } from "@tanstack/react-query";
import type { DocMeta } from "@/lib/api";

/** Publish an observed icon only after cancelling an older metadata request. */
export async function publishDocumentIcon(qc: QueryClient, key: readonly unknown[], icon: string, isCurrent: () => boolean): Promise<void> {
  await qc.cancelQueries({ queryKey: key, exact: true });
  if (!isCurrent()) return;
  qc.setQueryData<DocMeta>(key, (previous) => previous ? { ...previous, icon } : previous);
  for (const listKey of [["docs"], ["shared"], ["favorites"], ["recent"], ["search"]]) void qc.invalidateQueries({ queryKey: listKey });
  void qc.invalidateQueries({ queryKey: key, exact: true });
}
