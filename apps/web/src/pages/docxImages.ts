import { imageInfo, type DocxImage } from "@/lib/docx";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;

/**
 * Fetch the document's image attachments (same-origin `/api/files/:id`, sent
 * with the user's session) for embedding in a Word export. Failures are not
 * fatal: missing images are reported as export losses instead.
 */
export async function fetchDocxImages(
  blocks: { type: string; props: Record<string, string> }[],
  fetcher: (url: string) => Promise<Response> = (url) => fetch(url, { credentials: "same-origin" }),
): Promise<Map<string, DocxImage>> {
  const images = new Map<string, DocxImage>();
  const ids = [...new Set(blocks.filter((b) => b.type === "image" && /^[\w-]+$/.test(b.props.fileId ?? "")).map((b) => b.props.fileId))];
  let total = 0;
  for (const id of ids) {
    try {
      const response = await fetcher(`/api/files/${encodeURIComponent(id)}`);
      if (!response.ok) continue;
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > MAX_IMAGE_BYTES || total + declared > MAX_TOTAL_BYTES) continue;
      const data = new Uint8Array(await response.arrayBuffer());
      if (data.length > MAX_IMAGE_BYTES || total + data.length > MAX_TOTAL_BYTES) continue;
      const info = imageInfo(data);
      if (!info || !info.width || !info.height) continue;
      total += data.length;
      images.set(id, { ...info, data });
    } catch { /* reported as a loss */ }
  }
  return images;
}
