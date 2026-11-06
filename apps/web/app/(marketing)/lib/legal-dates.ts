// Dates on the Privacy and Terms pages. Each is a calendar day written as `YYYY-MM-DD` and read in UTC, so the
// page and the tests agree wherever the server runs.

const DAY_MS = 24 * 60 * 60 * 1000;

function dayStart(iso: string): number {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(t)) throw new Error(`Not a calendar day: ${iso}`);
  return t;
}

/** "November 2, 2026" */
export function formatLegalDate(iso: string): string {
  return new Date(dayStart(iso)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** The day `days` after `iso`, as `YYYY-MM-DD`. */
export function addLegalDays(iso: string, days: number): string {
  return new Date(dayStart(iso) + days * DAY_MS).toISOString().slice(0, 10);
}

/** True until the start of `iso` (UTC). */
export function isBeforeLegalDay(iso: string, now: Date = new Date()): boolean {
  return now.getTime() < dayStart(iso);
}
