import { ConflictException, ForbiddenException } from "@nestjs/common";

/**
 * units_v1 — the fail-closed net under every path that REWRITES existing lines.
 *
 * A "unit-aware" line is one sold by a non-pack unit (`unitLabel != null`: a Case, a Pallet, or a
 * Piece off a boxed pack) and carries its OWN factor in `unitsPerBox`. Most order/invoice
 * rewrite paths were written when a line's unit could only ever be the pack, so they re-derive the
 * factor, the price and the tier from the LIVE product and match "the same line" by `productId`
 * alone — which would silently re-price a Case line at the pack's size (the verified 4× overcharge)
 * or fold it into a pack line of the same product.
 *
 * Until each path is converted to `resolveLineUnits` (./products/line-units.ts), it must REFUSE to
 * touch such a line, with a message an operator can act on. `unit-aware-guard-callsites.spec.ts`
 * fails the build if any listed rewrite path stops calling this. Converting a path means deleting
 * its guard call in the same PR that makes it unit-aware and updating that spec.
 *
 * Nothing can create a unit-aware line yet (no DTO accepts `unitLabel`), so this is inert today.
 */
export const UNIT_AWARE_LINE = "UNIT_AWARE_LINE";

interface LineLike {
  unitLabel?: string | null;
  status?: string | null;
}

/** A live (not CANCELLED) line sold by a non-pack unit. */
export const isUnitAwareLine = (li: LineLike | null | undefined): boolean =>
  !!li && li.unitLabel != null && li.unitLabel !== "" && li.status !== "CANCELLED";

/**
 * Prisma `where` fragment: orders with NO live unit-aware line. Add it to any query that picks
 * merge candidates, so a unit-aware order is treated like an operator-separated (skipAutoMerge) one.
 */
export const ORDER_HAS_NO_UNIT_AWARE_LINE = {
  lineItems: { none: { unitLabel: { not: null }, status: { not: "CANCELLED" } } },
} as const;

/** Throws 409 `UNIT_AWARE_LINE` if any of `lines` is a live unit-aware line. */
export function assertNoUnitAwareLines(
  lines: ReadonlyArray<LineLike> | null | undefined,
  action = "edited this way",
): void {
  const hit = (lines ?? []).find(isUnitAwareLine);
  if (!hit) return;
  throw new ConflictException({
    code: UNIT_AWARE_LINE,
    message: `A line on this order is sold by the ${hit.unitLabel}, so it can't be ${action} yet. Edit it from the web order screen.`,
  });
}

interface EditDto {
  replaceAll?: boolean;
  items?: Array<{ id?: string | null; action?: string | null }>;
}

/**
 * `updateOrderItems` entry guard. Every branch (buyer/driver/staff replace-all, diff add,
 * substitute, qty/price edit) re-derives the factor + price from the LIVE product, so an order with
 * a unit-aware line is refused — EXCEPT a diff of ONLY CANCEL/DELETE entries, which just strikes
 * lines off (no factor, no price) and is the operator's only way to remove a mistaken Case line.
 * A buyer's ownership is settled FIRST (`findOwner`): the refusal names a unit on THIS order,
 * which a non-owner must never learn.
 */
export async function assertOrderEditAllowed(
  order: { customerId: string; lineItems: ReadonlyArray<LineLike> },
  dto: EditDto,
  user: { role?: string } | undefined,
  findOwner: () => Promise<{ id: string } | null>,
): Promise<void> {
  const items = dto.items ?? [];
  const strikeOffOnly =
    dto.replaceAll === false &&
    items.length > 0 &&
    items.every((i) => i.id != null && (i.action === "CANCEL" || i.action === "DELETE"));
  if (strikeOffOnly || !order.lineItems.some(isUnitAwareLine)) return;
  if (user?.role === "CUSTOMER") {
    const owner = await findOwner();
    if (!owner || owner.id !== order.customerId) throw new ForbiddenException();
  }
  assertNoUnitAwareLines(order.lineItems, "edited");
}

/**
 * At-the-door change-request guard: CHANGE_QTY / ADD_ITEM re-derive from the live pack, so refuse
 * only when the request TARGETS a unit-aware line (its own line, or a line of the product an
 * ADD_ITEM folds into). REMOVE_ITEM only strikes a line off; an unrelated pack line stays editable.
 */
export function assertChangeTargetAllowed(
  lines: ReadonlyArray<LineLike & { id?: string; productId?: string | null }>,
  cr: { type: string; orderItemId?: string | null; productId?: string | null },
  payload: { orderItemId?: string; productId?: string } | null | undefined,
): void {
  if (cr.type === "REMOVE_ITEM") return;
  const lineId = cr.orderItemId ?? payload?.orderItemId ?? null;
  const productId = cr.productId ?? payload?.productId ?? null;
  assertNoUnitAwareLines(
    lines.filter((li) =>
      cr.type === "CHANGE_QTY" ? li.id === lineId : productId != null && li.productId === productId,
    ),
    "changed at the stop",
  );
}

interface InvoiceDb {
  invoiceItem: { findMany(args: unknown): Promise<LineLike[]> };
  orderItem: { findMany(args: unknown): Promise<LineLike[]> };
}

/**
 * Draft-invoice rewrite guard. Checks the invoice's OWN lines AND its linked order's lines: an
 * invoice built by a path that drops `unitLabel` carries none, but the back-sync
 * (recomputeOrderFromInvoices) writes this edit straight onto the order line that does.
 */
export async function assertInvoiceRewriteAllowed(
  db: InvoiceDb,
  invoice: { id: string; orderId?: string | null },
): Promise<void> {
  const own = await db.invoiceItem.findMany({
    where: { invoiceId: invoice.id, unitLabel: { not: null } },
    select: { unitLabel: true },
  });
  const linked = invoice.orderId
    ? await db.orderItem.findMany({
        where: { orderId: invoice.orderId, unitLabel: { not: null }, status: { not: "CANCELLED" } },
        select: { unitLabel: true, status: true },
      })
    : [];
  assertNoUnitAwareLines([...own, ...linked], "edited");
}
