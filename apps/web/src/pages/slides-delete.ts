import type { SlidesPage } from "@/lib/api";

/** Only a matching receipt confirms which revision the server deleted. */
export function validSlideDeleteReceipt(value: unknown, page: Pick<SlidesPage, "id" | "slidesId" | "revision">): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return receipt.deletedId === page.id && receipt.slidesId === page.slidesId && receipt.revision === page.revision;
}
