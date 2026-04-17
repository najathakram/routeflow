import * as sharp from "sharp";

export interface CompressResult {
  buffer: Buffer;
  mimeType: string;
  ext: string;
}

/**
 * Normalize an uploaded document to stored form:
 * - Images → resized to max 1600px wide, JPEG q80
 * - PDFs  → passthrough
 * Throws if the mime type is not image/* or application/pdf.
 */
export async function compressDocument(buffer: Buffer, mimeType: string): Promise<CompressResult> {
  if (mimeType === "application/pdf") {
    return { buffer, mimeType: "application/pdf", ext: "pdf" };
  }
  if (mimeType.startsWith("image/")) {
    const out = await (sharp as any)(buffer)
      .resize({ width: 1600, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return { buffer: out, mimeType: "image/jpeg", ext: "jpg" };
  }
  throw new Error(`Unsupported mime type: ${mimeType}`);
}
