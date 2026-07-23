// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp: (buf: Buffer) => any = require("sharp");

export interface CompressResult {
  buffer: Buffer;
  mimeType: string;
  ext: string;
}

/**
 * Normalize an uploaded document to stored form:
 * - PDFs  → passthrough
 * - Everything else → treated as an image and re-encoded to JPEG (max 1600px wide).
 *   sharp detects the real format from the buffer bytes, so an image sent with a
 *   generic or missing content-type (e.g. application/octet-stream from a mobile
 *   file picker) still compresses. Throws if the bytes aren't a decodable image.
 */
export async function compressDocument(buffer: Buffer, mimeType: string): Promise<CompressResult> {
  if (mimeType === "application/pdf") {
    return { buffer, mimeType: "application/pdf", ext: "pdf" };
  }
  const out = (await sharp(buffer)
    .resize({ width: 1600, withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer()) as Buffer;
  return { buffer: out, mimeType: "image/jpeg", ext: "jpg" };
}

/**
 * Compress an uploaded IMAGE for storage, preserving transparency:
 * - resize to max `maxWidth`px wide (no enlargement), auto-orient via EXIF
 * - images WITH an alpha channel (PNG/WebP cut-outs, logos) → WebP q82 (keeps alpha)
 * - opaque images → JPEG q80 (smallest)
 * Throws if the mime type is not image/*. Callers that must also accept PDFs
 * should use `compressDocument` instead.
 */
export async function compressImage(
  buffer: Buffer,
  mimeType: string,
  maxWidth = 1600,
): Promise<CompressResult> {
  if (!mimeType.startsWith("image/")) {
    throw new Error(`Unsupported mime type: ${mimeType}`);
  }
  const img = sharp(buffer).rotate(); // honor EXIF orientation, then strip the tag
  const meta = await img.metadata();
  img.resize({ width: maxWidth, withoutEnlargement: true });
  if (meta.hasAlpha) {
    const out = (await img.webp({ quality: 82 }).toBuffer()) as Buffer;
    return { buffer: out, mimeType: "image/webp", ext: "webp" };
  }
  const out = (await img.jpeg({ quality: 80 }).toBuffer()) as Buffer;
  return { buffer: out, mimeType: "image/jpeg", ext: "jpg" };
}
