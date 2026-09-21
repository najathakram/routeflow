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
 * Order create (4b-2b) and manual-invoice create (4c-1) now mint unit-aware lines (behind flag.units_v1);
 * every REWRITE path stays fenced here until it is converted.
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

/**
 * NULL-TENANT BLIND SPOT: `forTenant()` scopes a TOP-LEVEL `orderItem`/`invoiceItem` read by the
 * ITEM's own `tenantId` (both columns are nullable), so a line whose tenantId is NULL — a legacy
 * orphan, or a row written by a tenant-less caller — is invisible to it and would slip past the
 * guard. So the guards below read the PARENT (`invoice` / `order`) and select the lines through
 * the relation, which Prisma does not tenant-filter.
 *
 * That moves the blind spot up one level, it does not erase it: `Order.tenantId` and
 * `Invoice.tenantId` are ALSO nullable (the owner-ruled NOT NULL migration is the real close-out).
 * Until then a parent that cannot be read FAILS CLOSED here (409) rather than passing.
 * `unit-line-writers.ast.spec.ts` fails if THIS module reads a line table top-level again.
 */
interface ParentDb {
  // `any` results: the Prisma delegates return their full row type; only `items`/`lineItems` are read.
  invoice: { findFirst(args: unknown): Promise<any> };
  order: { findFirst(args: unknown): Promise<any> };
}

/**
 * Draft-invoice rewrite guard. Checks the invoice's OWN lines AND its linked order's lines: an
 * invoice built by a path that drops `unitLabel` carries none, but the back-sync
 * (recomputeOrderFromInvoices) writes this edit straight onto the order line that does.
 */
export async function assertInvoiceRewriteAllowed(
  db: ParentDb,
  invoice: { id: string; orderId?: string | null },
): Promise<void> {
  const own = await db.invoice.findFirst({
    where: { id: invoice.id },
    select: {
      items: { where: { unitLabel: { not: null } }, select: { unitLabel: true }, take: 1 },
    },
  });
  const linked = invoice.orderId
    ? await db.order.findFirst({
        where: { id: invoice.orderId },
        select: {
          lineItems: {
            where: { unitLabel: { not: null }, status: { not: "CANCELLED" } },
            select: { unitLabel: true, status: true },
          },
        },
      })
    : null;
  // Fail CLOSED: a parent we cannot read (NULL-tenant / cross-tenant / vanished) proves nothing.
  if (!own || (invoice.orderId && !linked)) {
    throw new ConflictException({
      code: "UNIT_AWARE_LINE_UNVERIFIABLE",
      message: "This invoice's lines could not be verified, so it can't be edited. Ask an admin.",
    });
  }
  assertNoUnitAwareLines(
    [...((own.items ?? []) as LineLike[]), ...((linked?.lineItems ?? []) as LineLike[])],
    "edited",
  );
}
