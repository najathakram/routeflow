/** Shared bits of the authed "fetch a CSV as a blob" export buttons. */

/** YYYY-MM-DD in UTC, `daysAgo` days before today (matches `csvFilename`'s UTC day). */
export function isoDay(daysAgo = 0): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

/** Text of a Blob (jsdom and old browsers lack `Blob.text`). */
function blobText(b: Blob): Promise<string> {
  if (typeof b.text === "function") return b.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(r.error);
    r.readAsText(b);
  });
}

/** Fixed line for an error body that is a Blob but not JSON (a proxy's HTML page, say). */
const EXPORT_FAILED_LINE = "The export failed. Please try again or contact support.";

/** Toast description for a failed export: a friendly line for the throttle, else the server's
 *  message, else the client error's own. With `responseType: "blob"` an error body arrives as a
 *  Blob, so it is parsed as JSON first (a non-JSON body gets the fixed friendly line). */
export async function exportErrorMessage(err: unknown): Promise<string> {
  const e = err as { message?: string; response?: { status?: number; data?: unknown } };
  if (e?.response?.status === 429) return "Too many exports — try again in a minute.";
  let data = e?.response?.data as { message?: unknown } | Blob | undefined;
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    try {
      data = JSON.parse(await blobText(data)) as { message?: unknown };
    } catch {
      return EXPORT_FAILED_LINE;
    }
  }
  const msg = (data as { message?: unknown } | undefined)?.message;
  if (typeof msg === "string") return msg;
  if (Array.isArray(msg) && msg.every((m) => typeof m === "string")) return msg.join(", ");
  return e?.message || "Something went wrong. Please try again.";
}

/** True when the downloaded stream ends with the server's `# export failed` or `# truncated`
 *  line — the file is usable but not complete. Reads only the tail. */
export async function exportTailWarning(blob: Blob): Promise<boolean> {
  try {
    const tail = await blobText(blob.slice(Math.max(0, blob.size - 400)));
    return /(^|\n)# (export failed|truncated)[^\n]*\s*$/.test(tail);
  } catch {
    return false;
  }
}

/** `filename` from a Content-Disposition header value, when present. */
export function filenameFromDisposition(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /filename="?([^";]+)"?/i.exec(value);
  return m ? m[1] : null;
}
