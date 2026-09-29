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

const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;
const SAFE_FILE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,10}$/;

/**
 * True when a stored value is EXACTLY one of our pod storage keys for this tenant,
 * `tenants/<tenantId>/pod/<stopId>/<name>.<ext>`, i.e. safe to presign and hand to a client.
 *
 * #2542 (SECURITY): a prefix test is not enough. The complete-stop DTO accepts arbitrary strings,
 * and `tenants/<own>/pod/../../<other>/…` passed `startsWith` while naming another tenant's object.
 * So the key must have exactly five segments, each from a safe alphabet: no `..` or `.` segment,
 * no empty segment (`//`), no backslash, no percent-encoding, no nesting. Checked on write
 * (`podCaptureValueRefusal`) AND at every sign site.
 */
export function isPodStorageKey(value: string, tenantId: string): boolean {
  if (typeof value !== "string" || typeof tenantId !== "string") return false;
  if (!SAFE_SEGMENT.test(tenantId)) return false;
  const parts = value.split("/");
  return (
    parts.length === 5 &&
    parts[0] === "tenants" &&
    parts[1] === tenantId &&
    parts[2] === "pod" &&
    SAFE_SEGMENT.test(parts[3]) &&
    SAFE_FILE.test(parts[4])
  );
}

/** Legacy captures from older app builds that are stored but never signed. */
const LEGACY_POD_SENTINELS = new Set(["native-captured"]);

/**
 * #2542: why a client-supplied POD value (signatureUrl / a podPhotoUrls entry) is refused, or null
 * when it may be stored. A value with a URI scheme (`data:image/…` to ingest, a device-local
 * `file:`/`content:`/`ph:` URI) is never signed and passes; any schemeless value is a storage key
 * and must be exactly this tenant's pod key (or the legacy sentinel). A blank value (empty or
 * whitespace) is refused (#2585 / SA-519).
 *
 * #2550: with `stopId`, a key must also belong to THAT stop (`parts[3] === stopId`), so a
 * completion cannot relink another stop's artifacts, even within the tenant. `null` is refused
 * (not treated as "absent"): stored, it would silently clear an existing signature, and no client
 * sends it.
 */
export function podCaptureValueRefusal(
  value: unknown,
  tenantId: string,
  stopId?: string,
): string | null {
  if (typeof value !== "string") return "a POD value must be a string";
  const v = value.trim();
  // #2585 / SA-519: a present-but-blank value is refused, never coerced to "absent" (it would
  // overwrite a stored signature with nothing). Absent means omitted.
  if (v === "") return "a POD value must not be blank (omit the field to leave it unchanged)";
  if (LEGACY_POD_SENTINELS.has(v)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return null;
  if (!isPodStorageKey(v, tenantId))
    return "a POD value must be an image capture or this tenant's own proof-of-delivery key";
  if (stopId !== undefined && v.split("/")[3] !== stopId)
    return "a POD value must be this stop's own proof-of-delivery key";
  return null;
}

/**
 * A stored data URL is directly renderable by a browser <img> without any
 * presigning (fallback for artifacts whose server-side rasterize failed).
 */
export function isRenderableDataUrl(value: string): boolean {
  return value.startsWith("data:image/");
}
