import type { FeatureChangeInput, FeatureChangeRecord } from "@routeflow/types";
import type { FeatureChangeLogRow, SkippedExpiredRow } from "@/lib/platform-admin/feature-changes";

/** "Maria": the name a person knows the admin by (email before username, no raw ids). */
export function whoDid(row: FeatureChangeLogRow): string {
  return row.actor?.email || row.actor?.username || "Someone";
}

/** What one saved change did, in words: "turned off Sales agents". */
function didWhat(label: string, change: FeatureChangeRecord): string {
  if (!change.after) return `cleared the override on ${label}`;
  return `${change.after.effect === "GRANT" ? "turned on" : "turned off"} ${label}`;
}

/** SA-1133: what an undo left alone, one sentence per feature: "Not restored: Sales agents. Its end date has passed." */
export function notRestoredCopy(
  skipped: readonly SkippedExpiredRow[] | undefined,
  labelOf: (key: string) => string,
): string {
  const keys = [...new Set((skipped ?? []).map((s) => s.key))];
  return keys.map((k) => `Not restored: ${labelOf(k)}. Its end date has passed.`).join(" ");
}

function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * R48: a saved set as one sentence, "who, what, why". Raw action codes never reach the page.
 * "maria@acme.test turned off Sales agents and turned on MSRP on invoices. Reason: Pilot ended."
 */
export function describeChangeSet(
  row: FeatureChangeLogRow,
  labelOf: (key: string) => string,
): string {
  const who = whoDid(row);
  const reason = row.meta?.reason?.trim();
  const tail = reason ? ` Reason: ${reason}${/[.!?]$/.test(reason) ? "" : "."}` : "";
  if (row.action === "FEATURE_CHANGE_SET_UNDONE") {
    const left = notRestoredCopy(row.meta?.skippedExpired, labelOf);
    return `${who} undid an earlier change.${tail}${left ? ` ${left}` : ""}`;
  }
  const changes = row.meta?.changes ?? [];
  if (changes.length === 0) return `${who} saved feature changes.${tail}`;
  return `${who} ${joinWords(changes.map((c) => didWhat(labelOf(c.key), c)))}.${tail}`;
}

/** Same rule as the server's isLiveOverride (billing/feature-override-rule.ts): no end date, or one in the future. */
const stillApplies = (expiresAt: string | null | undefined, nowMs: number): boolean =>
  expiresAt == null || new Date(expiresAt).getTime() > nowMs;

/**
 * The set that puts a saved set's "before" back (R50): a key that had no override is cleared; a key that had one gets
 * that override again with its own kind and end date (a pilot comes back as a pilot, not a standing grant). A "before"
 * whose end date has passed is not put back and is named (SA-1133, same shape and copy as undo).
 * Goes through the same review sheet as any other change.
 */
export function restorePlan(
  row: FeatureChangeLogRow,
  nowMs: number = Date.now(),
): { changes: FeatureChangeInput[]; skippedExpired: SkippedExpiredRow[] } {
  const changes: FeatureChangeInput[] = [];
  const skippedExpired: SkippedExpiredRow[] = [];
  for (const c of row.meta?.changes ?? []) {
    if (c.before === null) {
      if (c.after !== null) changes.push({ type: "override", key: c.key, action: "CLEAR" });
    } else if (!stillApplies(c.before.expiresAt, nowMs)) {
      skippedExpired.push({ key: c.key, id: c.before.id, expiresAt: c.before.expiresAt });
    } else {
      changes.push({
        type: "override",
        key: c.key,
        action: c.before.effect === "GRANT" ? "GRANT" : "DENY",
        kind: c.before.kind,
        ...(c.before.expiresAt ? { expiresAt: c.before.expiresAt } : {}),
      });
    }
  }
  return { changes, skippedExpired };
}

export const restoreInputs = (row: FeatureChangeLogRow, nowMs?: number): FeatureChangeInput[] =>
  restorePlan(row, nowMs).changes;

/**
 * Only the newest row can still be undone (the server refuses once anything changed after it), and only if it is a
 * saved set that no later undo has taken back. The server is the judge; this only decides whether to offer the button.
 */
export function undoableId(rows: FeatureChangeLogRow[]): string | null {
  const newest = rows[0];
  if (!newest || newest.action !== "FEATURE_CHANGE_SET_APPLIED") return null;
  return newest.id;
}
