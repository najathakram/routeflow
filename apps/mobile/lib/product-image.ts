/**
 * Pure helpers for product image upload. The API (products.controller
 * `POST /:id/images`) accepts ONLY image/jpeg | image/png | image/webp;
 * expo-image-picker returns an asset with `uri` + optional `mimeType`/`fileName`.
 * Build the React-Native multipart file object and infer a safe mime + name so
 * the strict fileFilter never rejects the upload. Screen-free for __tests__.
 */

export const ALLOWED_IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;
export type AllowedImageMime = (typeof ALLOWED_IMAGE_MIMES)[number];

const EXT_MIME: Record<string, AllowedImageMime> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

function isAllowed(mime: string | null | undefined): mime is AllowedImageMime {
  return !!mime && (ALLOWED_IMAGE_MIMES as readonly string[]).includes(mime);
}

/** Infer an allowed mime from a file/uri extension (ignores any query string). */
export function mimeFromUri(uri: string): AllowedImageMime | undefined {
  const path = uri.split("?")[0];
  const ext = path.match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase();
  return ext ? EXT_MIME[ext] : undefined;
}

function extForMime(mime: AllowedImageMime): string {
  return mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
}

export interface ImageUploadFile {
  uri: string;
  name: string;
  type: AllowedImageMime;
}

/**
 * Build the multipart file for one picked asset. Prefers the asset's own
 * mimeType (when allowed), then the uri extension, then JPEG — the server
 * generates a UUID key, so the filename is metadata only (kept meaningful).
 */
export function productImageFile(asset: {
  uri: string;
  mimeType?: string | null;
  fileName?: string | null;
}): ImageUploadFile {
  const type: AllowedImageMime = isAllowed(asset.mimeType)
    ? asset.mimeType
    : (mimeFromUri(asset.uri) ?? "image/jpeg");
  // Only keep the source fileName when its extension matches the RESOLVED type —
  // otherwise a coerced mime (e.g. an iOS HEIC picked as image/heic, forced to
  // JPEG) would ship a misleading ".heic" name. Callers should also transcode
  // disallowed formats before building the file; this is defense-in-depth.
  const fileName = asset.fileName?.trim();
  const name = fileName && mimeFromUri(fileName) === type ? fileName : `photo.${extForMime(type)}`;
  return { uri: asset.uri, name, type };
}
