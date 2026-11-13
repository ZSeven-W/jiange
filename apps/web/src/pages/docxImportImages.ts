import type { DocxImportResult } from "@/lib/docx";
import type { FileMeta } from "@/lib/api";
import type { MdBlock } from "@/lib/markdown";

/** Upload before constructing any document operations. Never insert unresolved IDs. */
export async function uploadDocxImportImages(
  result: DocxImportResult,
  upload: (file: File) => Promise<FileMeta>,
  canContinue: () => boolean,
): Promise<MdBlock[]> {
  const refs = [...new Set(result.blocks.filter((block) => block.type === "image").map((block) => block.props.importImageId))];
  const uploaded = new Map<string, FileMeta>();
  for (const id of refs) {
    const image = result.images?.get(id);
    if (!id || !image || !canContinue()) throw new Error("image import unavailable");
    const ext = image.contentType === "image/png" ? "png" : image.contentType === "image/gif" ? "gif" : "jpg";
    const file = new File([image.data.slice().buffer as ArrayBuffer], `word-image.${ext}`, { type: image.contentType });
    const meta = await upload(file);
    if (!Number.isSafeInteger(meta.id) || meta.id <= 0 || !canContinue()) throw new Error("image upload not confirmed");
    uploaded.set(id, meta);
  }
  if (!canContinue()) throw new Error("document unavailable");
  return result.blocks.map((block) => {
    if (block.type !== "image") return block;
    const meta = uploaded.get(block.props.importImageId);
    if (!meta) throw new Error("image missing");
    const { importImageId: _id, ...props } = block.props;
    return { ...block, props: { ...props, fileId: String(meta.id), mime: meta.mime, name: props.name || meta.name } };
  });
}
