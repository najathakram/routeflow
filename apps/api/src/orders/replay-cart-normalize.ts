import { assertReplaySameCart } from "./replay-same-cart";

// The replay surface of create(): the cart compare and the idempotency-key violation test, from one place.
export { isIdempotencyKeyViolation } from "./replay-same-cart";
import { resolveLineUnits } from "../products/line-units";
import type { CreateOrderOptions, ReplayedOrder } from "./order-create-options";
import { derivedBaseAsPack, isUnitAware, loadUnitLadders, requestsUnit } from "./unit-line-build";

/**
 * Units P0b / SA-759r B1: the stored order holds an old client's derived Piece as the PACK line's pieces
 * (`derivedBaseAsPack` at create), so the Idempotency-Key replay comparison must see the retried body the same
 * way. EVERY replay compare (create()'s pre-check and race exit, the staff fold's key hit) runs the request
 * items through here first; it reads only when a line names a unit, so a pack-only cart costs nothing and comes
 * back as the SAME array.
 *
 * SA-1047: a line that names a unit which create() resolves to the PACK (the pack's own label "Box", a Piece on a
 * pack-less product) is stored as a pack line (`unitLabel` null), so it is compared as one: with `unitLabel` null.
 * The resolution is create()'s own call (`resolveLineUnits`) on the rows already read here; a label it cannot resolve
 * (it throws) is returned as sent, and create() refuses it as before.
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
  return items.map((i) => {
    const line = derivedBaseAsPack(i, productMap, ladders, cpMap, defaultTier);
    const p = requestsUnit(line) && line.productId ? productMap.get(line.productId) : undefined;
    if (!p) return line;
    try {
      return isUnitAware(resolveLineUnits(p, ladders.get(p.id) ?? [], line))
        ? line
        : { ...line, unitLabel: null };
    } catch {
      return line;
    }
  });
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

/**
 * `assertReplaySameCart` on the cart as the server stores it (the one call every replay exit makes), then the caller's
 * `onReplay` with the ORIGINAL order and the cart that was compared (SA-1047), so a caller that judges more of the replay
 * (the counter's price check) reads the same lines the compare saw, not the raw request.
 */
export async function assertReplayOfCart(
  db: any,
  customerId: string,
  existing: Parameters<typeof assertReplaySameCart>[0],
  dto: Parameters<typeof assertReplaySameCart>[1] & { items?: ReadonlyArray<any> | null },
  options?: Pick<CreateOrderOptions, "onReplay">,
): Promise<void> {
  const cart = await replayCartOf(db, customerId, dto);
  assertReplaySameCart(existing, cart);
  options?.onReplay?.(existing as ReplayedOrder, cart.items ?? null);
}
