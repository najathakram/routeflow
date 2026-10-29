/**
 * SA-845 (W-662, B1247): is a price write that would be a 409 really the client's OWN earlier write, re-sent after its
 * reply was lost (a dropped connection, a double click)? The server decides, exactly, from the audit row the write
 * already stored; it is evaluated only on the path that is a 409 today. It is the same write when ALL hold:
 *  - the same actor (never null: two unknown actors are not provably the same);
 *  - the client's expected revision is the write's `revisionBefore` (and, for a save, its expected price state is the
 *    write's `priceStateBefore`);
 *  - the request is identical (canonical, key order ignored: jsonb does not keep it);
 *  - nothing was written since: the live revision and price state are the write's `revisionAfter` / `priceStateAfter`
 *    (a legacy writer that skips the revision bump still moves the price state).
 * Any miss, including a row written before this change (no `priceStateAfter`), answers false and today's 409 stays: a
 * false "yours" would hide someone else's change, a false conflict only costs a reload.
 */
export interface ReplayCheck {
  /** The stored audit meta (PRODUCT_PRICES_SAVED or PRODUCT_PRICES_UNDONE). */
  stored: unknown;
  actorId: string | null;
  expectedRevision: number;
  /** A save's expected price state; an undo has none to compare. */
  expectedPriceState?: string;
  /** The canonical request this retry would store (a save's request, or an undo's `{ skip }`). */
  request: unknown;
  live: { revision: number; priceState: string };
}

export function priceWriteReplay(c: ReplayCheck): boolean {
  const s = c.stored;
  if (s == null || typeof s !== "object" || Array.isArray(s)) return false;
  const m = s as Record<string, unknown>;
  if (c.actorId == null || m.actor !== c.actorId) return false;
  if (typeof m.revisionBefore !== "number" || m.revisionBefore !== c.expectedRevision) return false;
  if (typeof m.revisionAfter !== "number" || m.revisionAfter !== c.live.revision) return false;
  if (typeof m.priceStateAfter !== "string" || m.priceStateAfter !== c.live.priceState)
    return false;
  if (c.expectedPriceState !== undefined && m.priceStateBefore !== c.expectedPriceState)
    return false;
  return canonical(m.request) === canonical(c.request);
}

/** JSON with object keys sorted (arrays keep their order); undefined members dropped, as JSON storage drops them. */
function canonical(v: unknown): string {
  return JSON.stringify(sortKeys(v)) ?? "undefined";
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v != null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort()
        .map((k) => [k, sortKeys(o[k])]),
    );
  }
  return v;
}
