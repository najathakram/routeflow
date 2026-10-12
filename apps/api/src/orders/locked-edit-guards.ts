import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { latestEditRevisionNumber } from "./order-revisions";
import { loadUnitLadders, requestsUnit } from "./unit-line-build";
import type { UnitEditContext } from "./unit-line-edit";

/**
 * Row 372 (SA-735 items 2-4): the three checks `updateOrderItems` runs INSIDE its Order-locked transaction, before
 * the first write. Everything they read is the locked state, never the pre-transaction snapshot.
 */

/** Item 2: the client's `expectedRevisionNumber` must equal the latest OrderRevision (one derivation), else 409. */
export async function assertRevisionCurrent(
  tx: { orderRevision: { aggregate(args: any): Promise<any> } },
  orderId: string,
  expected: number | null | undefined,
): Promise<void> {
  if (expected == null) return; // a client that does not send it keeps working
  if ((await latestEditRevisionNumber(tx, orderId)) !== expected) {
    throw new ConflictException({
      code: API_ERROR_CODES.ORDER_REVISION_STALE,
      message: "This order changed since you opened it. Reload to see the latest.",
    });
  }
}

/**
 * Item 3: a payload line id that is not among the LOCKED lines was deleted by another writer. It is a retryable
 * 409, never a fallback to the pre-transaction snapshot (which turned a vanished id into a P2025 or a stale write).
 */
function assertPayloadLinesHeld(
  items: ReadonlyArray<{ id?: string | null }> | undefined,
  heldById: ReadonlyMap<string, unknown>,
): void {
  for (const it of items ?? []) {
    if (it.id && !heldById.has(it.id)) {
      throw new ConflictException({
        code: API_ERROR_CODES.CONCURRENT_UPDATE,
        message: "A line on this order was changed by someone else. Reload and try again.",
      });
    }
  }
}

/**
 * Item 4 (B720): `unitCtx` is built BEFORE the lock and stays an optimisation. Every product the locked lines
 * and the payload name for a unit-aware edit that the pre-lock context did not load is read here, inside the
 * transaction, so a concurrent substitution can never leave a `map.get(...)!` empty.
 */
async function loadMissingUnitProducts(
  tx: {
    product: { findMany(args: any): Promise<any[]> };
    productUnit: { findMany(args: any): Promise<any[]> };
  },
  unitCtx: UnitEditContext,
  heldItems: ReadonlyArray<{ productId?: string | null; unitLabel?: string | null }>,
  heldById: ReadonlyMap<string, { productId?: string | null }>,
  items: ReadonlyArray<{
    id?: string | null;
    productId?: string | null;
    substituteProductId?: string | null;
    unitLabel?: string | null;
  }>,
): Promise<void> {
  const wanted = new Set<string>();
  for (const h of heldItems) if (h.unitLabel != null && h.productId) wanted.add(h.productId);
  for (const it of items) {
    if (!requestsUnit(it)) continue;
    for (const pid of [
      it.productId,
      it.substituteProductId,
      it.id && heldById.get(it.id)?.productId,
    ])
      if (pid) wanted.add(pid);
  }
  const missing = [...wanted].filter((pid) => !unitCtx.products.has(pid));
  if (missing.length === 0) return;
  for (const p of await tx.product.findMany({ where: { id: { in: missing } } }))
    unitCtx.products.set(p.id, p);
  for (const [pid, ladder] of await loadUnitLadders(tx, missing)) unitCtx.ladders.set(pid, ladder);
}

/**
 * The post-lock checks in one call: a vanished payload line id is 409 (item 3), then the products a unit-aware
 * edit needs that the pre-lock context did not load are read inside the transaction (item 4 / B720).
 */
export async function assertLockedEditLines(
  tx: Parameters<typeof loadMissingUnitProducts>[0],
  unitCtx: UnitEditContext,
  heldItems: ReadonlyArray<{
    id?: string | null;
    productId?: string | null;
    unitLabel?: string | null;
  }>,
  items:
    | ReadonlyArray<{
        id?: string | null;
        productId?: string | null;
        substituteProductId?: string | null;
        unitLabel?: string | null;
      }>
    | undefined,
): Promise<ReadonlyMap<string, any>> {
  const heldById = new Map<string, any>(heldItems.map((h) => [h.id as string, h]));
  assertPayloadLinesHeld(items, heldById);
  await loadMissingUnitProducts(tx, unitCtx, heldItems, heldById, items ?? []);
  return heldById;
}
