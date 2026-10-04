/**
 * OWNER RULING 2026-10-03 — a customer always gets their own tier / special price, whoever enters the
 * item; a DRIVER still cannot set a custom price or a discount.
 *
 * `updateOrderItems` used to resolve a NEW or SUBSTITUTED line's price through the customer's tier
 * only for staff (OPERATOR / TENANT_ADMIN) and billed every other caller at tier 1 (LIST). Drivers
 * now resolve exactly like staff; only the right to TYPE a price stays staff-only (B13, and
 * `classifyEditPayload` strips a driver's price fields from a diff payload before it gets here).
 *
 * Forward-only: an existing line keeps its STORED price on a driver qty edit — only lines created or
 * substituted from now on resolve the tier. Kept out of orders.service.ts (size ratchet).
 */
import { PriceType, UserRole } from "@prisma/client";

type Caller = { role?: string } | null | undefined;

const isStaff = (user: Caller): boolean =>
  user?.role === UserRole.OPERATOR || user?.role === UserRole.TENANT_ADMIN;

/** True for the driver app / driver token. */
export const isDriverCaller = (user: Caller): boolean => user?.role === UserRole.DRIVER;

/** Whose edit-items lines resolve the CUSTOMER's tier / special price: staff and drivers. */
export const linesPriceAtCustomerTier = (user: Caller): boolean =>
  isStaff(user) || isDriverCaller(user);

/**
 * The price a client typed on a line, honoured for staff only. A driver's is dropped (null) here as
 * well as by `classifyEditPayload`, so no later edit to either can let a driver price a line.
 */
export const typedLinePrice = (user: Caller, sent: number | string | null | undefined) =>
  isDriverCaller(user) || sent === undefined ? null : Number(sent);

/** What a replace-all keeps from an order line it re-creates (its agreed price and attribution). */
export interface KeptLinePrice {
  unitPrice: number;
  originalPrice: number | null;
  priceType: PriceType;
  qty: number;
  promoFreeUnits: number | null;
  overrideReason: string | null;
  overriddenBy: string | null;
}

/**
 * A DRIVER's replace-all deletes and re-creates every line, but an agreed line must keep its STORED
 * price (ruling 2026-10-03: only NEW lines resolve the tier). Pairs each listed product with the
 * order's existing line for it — same product, a pack line (no unit label), not cancelled, and
 * exactly ONE of each side (an ambiguous pairing is treated as new). Read BEFORE the delete.
 */
export function keptStoredLinePrices(
  existing: ReadonlyArray<any>,
  incoming: ReadonlyArray<{ productId?: string | null }>,
): Map<string, KeptLinePrice> {
  const kept = new Map<string, KeptLinePrice>();
  const countIn = (pid: string) => incoming.filter((i) => i.productId === pid).length;
  for (const pid of new Set(incoming.map((i) => i.productId).filter(Boolean) as string[])) {
    const held = existing.filter((l) => l.productId === pid && l.status !== "CANCELLED");
    const [li] = held;
    if (held.length !== 1 || countIn(pid) !== 1 || li.unitLabel || li.unitPrice == null) continue;
    kept.set(pid, {
      unitPrice: Number(li.unitPrice),
      originalPrice: li.originalPrice == null ? null : Number(li.originalPrice),
      priceType: li.priceType,
      qty: Number(li.qty),
      promoFreeUnits: li.promoFreeUnits ?? null,
      overrideReason: li.overrideReason ?? null,
      overriddenBy: li.overriddenBy ?? null,
    });
  }
  return kept;
}

/** The kept line as a `priced` result; free units only survive an unchanged qty. */
export const pricedFromKept = (k: KeptLinePrice, qty: number) => ({
  unitPrice: k.unitPrice,
  originalPrice: k.originalPrice,
  priceType: k.priceType,
  freeUnits: k.qty === qty ? Number(k.promoFreeUnits ?? 0) : 0,
});

/** The override attribution a kept line carries onto its re-created row. */
export const keptAttribution = (k: KeptLinePrice | undefined) =>
  k ? { overrideReason: k.overrideReason, overriddenBy: k.overriddenBy } : {};
