import { cartMismatchConflict, draftMismatchConflict } from "./merge-idempotency";
import { replayLineKey } from "./unit-line-build";

/**
 * BUG-A / SA-715: the ONE answer to "is this Idempotency-Key request a replay of the SAME request that
 * created `existing`?", called at EVERY replay exit - create()'s pre-check, create()'s P2002 race exit,
 * and the staff fold's Order-column key hit. A replay must be of the same cart AND the same kind
 * (draft vs real order); anything else is a coded 409 carrying the holding order's id, never a silent
 * acknowledgement of a stale or different order.
 *
 * Throws; returns void on a true replay.
 */
export function assertReplaySameCart(
  existing: { id: string; status?: string | null; lineItems?: ReadonlyArray<unknown> | null },
  dto: { items?: ReadonlyArray<unknown> | null; status?: string | null },
): void {
  // A draft the first press saved is NOT the order the second press asked for (and vice versa).
  const storedIsDraft = existing.status === "DRAFT";
  if (storedIsDraft !== (dto.status === "DRAFT")) {
    throw draftMismatchConflict(existing.id, storedIsDraft);
  }
  // R4: compare the incoming line multiset with the stored non-cancelled lines.
  const norm = (rows: ReadonlyArray<unknown>, stored: boolean) =>
    rows
      .map((r) => replayLineKey(r as never, stored))
      .sort()
      .join("|");
  const incoming = norm(dto.items ?? [], false);
  const live = (existing.lineItems ?? []).filter(
    (li) => (li as { status?: string }).status !== "CANCELLED",
  );
  if (incoming !== norm(live, true)) throw cartMismatchConflict(existing.id);
}
