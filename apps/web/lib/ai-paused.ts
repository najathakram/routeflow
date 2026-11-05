/**
 * "December 1": the UTC day a business's AI allowance starts again. The server sends the instant (`resetsAt`, the next
 * UTC month start, from the same helper the monthly sum uses), so the web never recomputes the boundary; it only words
 * it, in UTC, so it reads the same in every browser zone (SA-1102 A-3 RA-2, A-4 M1).
 */
export function aiResetDay(iso?: string | null): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "the 1st of next month";
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}
