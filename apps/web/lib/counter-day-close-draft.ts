/**
 * R7b 2.3 (B1263): the Close-day form's typed count, kept in sessionStorage so a dismissed dialog (X, Esc, outside click,
 * Cancel, or Today's sales closing) does not lose a drawer count. A FORM draft, never authoritative: the server recomputes
 * every figure on close. Keyed by tenant + register + tenant day (not by user, so a second cashier finishing the count sees
 * it). Every storage access is in try/catch: storage is a convenience and the form works without it.
 */
export const DAY_CLOSE_DRAFT_PREFIX = "rf:dayclose:draft:";
const DRAFT_VERSION = 1;

export interface DayCloseDraft {
  v: number;
  floatText: string;
  counts: Record<string, number>;
  notes: string;
}

export function dayCloseDraftKey(
  tenant: string | null | undefined,
  registerKey: string | null | undefined,
  tenantDay: string,
): string {
  return `${DAY_CLOSE_DRAFT_PREFIX}${tenant || "tenant"}:${registerKey || "main"}:${tenantDay}`;
}

export function readDayCloseDraft(key: string): DayCloseDraft | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<DayCloseDraft> | null;
    if (
      !d ||
      d.v !== DRAFT_VERSION ||
      typeof d.floatText !== "string" ||
      typeof d.notes !== "string"
    )
      return null;
    if (!d.counts || typeof d.counts !== "object") return null;
    const counts: Record<string, number> = {};
    for (const [k, n] of Object.entries(d.counts)) {
      if (typeof n === "number" && Number.isFinite(n) && n > 0) counts[k] = n;
    }
    return { v: DRAFT_VERSION, floatText: d.floatText, counts, notes: d.notes };
  } catch {
    return null;
  }
}

export function writeDayCloseDraft(key: string, draft: Omit<DayCloseDraft, "v">): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify({ v: DRAFT_VERSION, ...draft }));
  } catch {
    /* storage unavailable or full: the count just is not kept */
  }
}

export function clearDayCloseDraft(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    /* nothing was kept */
  }
}

/** Logout: drop every stored day-close draft in this tab, whoever it belonged to. */
export function clearAllDayCloseDrafts(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const k = window.sessionStorage.key(i);
      if (k && k.startsWith(DAY_CLOSE_DRAFT_PREFIX)) doomed.push(k);
    }
    doomed.forEach((k) => window.sessionStorage.removeItem(k));
  } catch {
    /* storage unavailable: nothing was kept */
  }
}
