import type { DocMeta } from "@/lib/api";

/** Export must match the server's download and locked-view policy. */
export function canExportBase(base: Pick<DocMeta, "role" | "copyProtected">, writeRestricted: boolean | undefined): boolean {
  if (base.role === "manage") return true;
  if (base.role !== "edit" && base.role !== "view") return false;
  return !base.copyProtected && writeRestricted === false;
}
