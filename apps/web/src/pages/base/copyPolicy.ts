import type { DocMeta } from "@/lib/api";

/** A refreshing policy is not authorization evidence. This is a UI guard. */
export function blocksBaseCopy(base: Pick<DocMeta, "copyProtected" | "role">, refreshing: boolean): boolean {
  return refreshing || (!!base.copyProtected && base.role !== "manage");
}

export function guardBaseClipboard(event: Pick<Event, "preventDefault">, blocked: boolean) {
  if (blocked) event.preventDefault();
}
