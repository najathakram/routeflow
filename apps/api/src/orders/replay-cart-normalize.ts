import { assertReplaySameCart } from "./replay-same-cart";

// The replay surface of create(): the cart compare and the idempotency-key violation test, from one place.
export { isIdempotencyKeyViolation } from "./replay-same-cart";
import { derivedBaseAsPack, loadUnitLadders, requestsUnit } from "./unit-line-build";

/**
 * Units P0b / SA-759r B1: the stored order holds an old client's derived Piece as the PACK line's pieces
 * (`derivedBaseAsPack` at create), so the Idempotency-Key replay comparison must see the retried body the same
 * way. EVERY replay compare (create()'s pre-check and race exit, the staff fold's key hit) runs the request
 * items through here first; it reads only when a line names a unit, so a pack-only cart costs nothing and comes
 * back as the SAME array.
 */
export async function normalizeReplayItems<
  T extends { productId?: string | null; unitLabel?: string | null },
>(
  db: any,
  customerId: string,
  items: ReadonlyArray<T> | null | undefined,
): Promise<ReadonlyArray<T> | null | undefined> {
  if (!items || !items.some((i) => requestsUnit(i) && i.productId)) return items;
  const ids = [
    ...new Set(
      items.filter((i) => requestsUnit(i) && i.productId).map((i) => i.productId as string),
    ),
  ];
  const [products, ladders, customer, customerPrices] = await Promise.all([
    db.product.findMany({ where: { id: { in: ids } } }),
    loadUnitLadders(db, ids),
    db.customer.findFirst({ where: { id: customerId }, select: { pricingTier: true } }),
    db.customerPrice.findMany({ where: { customerId, productId: { in: ids } } }),
  ]);
  const productMap = new Map<string, any>(products.map((p: any) => [p.id, p]));
  const cpMap = new Map<string, number | null>(
    customerPrices.map((cp: any) => [cp.productId, cp.pricingTier]),
  );
  const defaultTier = customer?.pricingTier ?? 1;
  return items.map((i) => derivedBaseAsPack(i, productMap, ladders, cpMap, defaultTier));
}

/** The cart a replay is compared on: the request body with its derived Pieces rewritten as the server stores them. */
export async function replayCartOf<D extends { items?: ReadonlyArray<any> | null }>(
  db: any,
  customerId: string,
  dto: D,
): Promise<D> {
  const items = await normalizeReplayItems(db, customerId, dto.items);
  return items === dto.items ? dto : { ...dto, items };
}

/** `assertReplaySameCart` on the cart as the server stores it (the one call every replay exit makes). */
export async function assertReplayOfCart(
  db: any,
  customerId: string,
  existing: Parameters<typeof assertReplaySameCart>[0],
  dto: Parameters<typeof assertReplaySameCart>[1] & { items?: ReadonlyArray<any> | null },
): Promise<void> {
  assertReplaySameCart(existing, await replayCartOf(db, customerId, dto));
}
