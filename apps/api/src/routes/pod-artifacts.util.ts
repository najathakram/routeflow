/**
 * Durable proof-of-delivery artifacts.
 *
 * POD photos and signatures arrive from the driver app as `data:image/...`
 * URLs inside plain JSON (never multipart — FormData requests are excluded
 * from the mobile offline queue, so a data-URL body is what keeps POD capture
 * working through an offline stop completion). The routes service ingests
 * them into object storage under `tenants/<tenantId>/pod/<stopId>/...` and
 * persists the storage KEY in the existing `RouteRunStop.podPhotoUrls` /
 * `signatureUrl` columns. Values that are neither a data URL nor one of our
 * pod keys (device-local `file://` URIs, the old "native-captured" sentinel)
 * are legacy captures from older app builds: they pass through unchanged and
 * are simply not retrievable.
 *
 * Pure helpers only — sharp/storage side effects stay in RoutesService.
 */

export const POD_ARTIFACT_KINDS = ["photo", "signature"] as const;
export type PodArtifactKind = (typeof POD_ARTIFACT_KINDS)[number];

/** Client-supplied artifact ids must stay key-safe (they end up in a storage key). */
export const POD_ARTIFACT_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

export interface ParsedImageDataUrl {
  mimeType: string;
  buffer: Buffer;
}

/**
 * Parse a `data:image/...` URL into its mime type + decoded bytes. Accepts
 * both `;base64,` payloads and percent-encoded text payloads (the mobile
 * signature SVG is ASCII either way). Returns null for anything that is not
 * an image data URL — callers treat null as "not ingestable, pass through".
 */
export function parseImageDataUrl(value: string): ParsedImageDataUrl | null {
  if (!value.startsWith("data:image/")) return null;
  const comma = value.indexOf(",");
  if (comma < 0) return null;
  const headerParts = value.slice(5, comma).split(";");
  const mimeType = headerParts[0].toLowerCase();
  if (!mimeType.startsWith("image/")) return null;
  const isBase64 = headerParts.some((p) => p.trim().toLowerCase() === "base64");
  const payload = value.slice(comma + 1);
  try {
    const buffer = isBase64
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");
    if (buffer.length === 0) return null;
    return { mimeType, buffer };
  } catch {
    return null;
  }
}

/** Storage prefix for one stop's POD artifacts (tenant-gated by uploads auth). */
export function podKeyPrefix(tenantId: string, stopId: string): string {
  return `tenants/${tenantId}/pod/${stopId}/`;
}

/** Full storage key for one artifact. */
export function podArtifactKey(
  tenantId: string,
  stopId: string,
  kind: PodArtifactKind,
  artifactId: string,
  ext: string,
): string {
  return `tenants/${tenantId}/pod/${stopId}/${kind}-${artifactId}.${ext}`;
}

/**
 * True when a stored value is one of OUR pod storage keys for this tenant —
 * i.e. safe to presign and hand to a client. The tenant pin matters: the
 * complete-stop DTO accepts arbitrary strings, so presigning must never be
 * reachable for a key naming another tenant's prefix.
 */
export function isPodStorageKey(value: string, tenantId: string): boolean {
  return value.startsWith(`tenants/${tenantId}/pod/`);
}

/**
 * A stored data URL is directly renderable by a browser <img> without any
 * presigning (fallback for artifacts whose server-side rasterize failed).
 */
export function isRenderableDataUrl(value: string): boolean {
  return value.startsWith("data:image/");
}
