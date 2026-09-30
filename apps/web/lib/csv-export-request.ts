/** Shared bits of the authed "fetch a CSV as a blob" export buttons. */

/** YYYY-MM-DD in UTC, `daysAgo` days before today (matches `csvFilename`'s UTC day). */
export function isoDay(daysAgo = 0): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

/** Toast description for a failed export: a friendly line for the throttle, else the server's
 *  message, else the client error's own. */
export function exportErrorMessage(err: unknown): string {
  const e = err as { message?: string; response?: { status?: number; data?: unknown } };
  if (e?.response?.status === 429) return "Too many exports — try again in a minute.";
  const data = e?.response?.data as { message?: unknown } | undefined;
  if (typeof data?.message === "string") return data.message;
  return e?.message || "Something went wrong. Please try again.";
}

/** `filename` from a Content-Disposition header value, when present. */
export function filenameFromDisposition(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /filename="?([^";]+)"?/i.exec(value);
  return m ? m[1] : null;
}
