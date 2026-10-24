import { ConflictException, ForbiddenException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

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
export const UNIT_AWARE_LINE = API_ERROR_CODES.UNIT_AWARE_LINE;

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

/**
 * Throws 409 `UNIT_AWARE_LINE` if any of `lines` is a live unit-aware line. `remedy` is the
 * sentence the message ends on — defaults to the EDIT-path remedy ("Edit it from the web order
 * screen."), which fits every REWRITE call site below. SA-142: a CREATE-path call site (nothing
 * exists yet to "edit") must pass its own remedy instead — see orders.controller.ts's merge
 * branch, which points at "Create as a separate order" rather than the web order screen.
 */
export function assertNoUnitAwareLines(
  lines: ReadonlyArray<LineLike> | null | undefined,
  action = "edited this way",
  remedy = "Edit it from the web order screen.",
): void {
  const hit = (lines ?? []).find(isUnitAwareLine);
  if (!hit) return;
  throw new ConflictException({
    code: UNIT_AWARE_LINE,
    message: `A line on this order is sold by the ${hit.unitLabel}, so it can't be ${action} yet. ${remedy}`,
  });
}

interface EditItemLike {
  id?: string | null;
  action?: string | null;
  productId?: string | null;
  unitLabel?: string | null;
  qty?: number;
  boxes?: number | null;
  pieces?: number | null;
  unitPrice?: number;
  overrideReason?: string | null;
  substituteProductId?: string | null;
  name?: string | null;
}

interface EditDto {
  replaceAll?: boolean;
  items?: EditItemLike[];
}

/**
 * SA-407 (#2272): is this CUSTOMER payload the ONE per-line diff a buyer may send an order that
 * holds a unit line? Every item must be either
 *   (a) `id` of a live UNIT line + that line's OWN stored `unitLabel` + a count in `qty` — a count
 *       up, a count down (productId may ride along, but only the line's own); or
 *   (b) `id` + `action` CANCEL/DELETE and nothing else — a removal.
 * `"ok"` routes it through the staff per-line diff (updateUnitLine at the line's snapshot factor).
 * A `conflict` names what the ruling REFUSES with 409 UNIT_AWARE_LINE: a unit switch, boxes/pieces on
 * a unit line, a NEW unit line. `"shape"` is any other diff (pack-line edits, prices, substitutes):
 * buyers still send those through the full replace, so the payload classifier keeps its 400.
 */
export type BuyerLineDiffVerdict = "ok" | "shape" | { conflict: string };

export function buyerLineDiffVerdict(
  lines: ReadonlyArray<LineLike & { id: string; productId?: string | null }>,
  dto: EditDto,
): BuyerLineDiffVerdict {
  const items = dto.items ?? [];
  if (dto.replaceAll !== false || items.length === 0) return "shape";
  const byId = new Map(lines.map((l) => [l.id, l]));
  let verdict: BuyerLineDiffVerdict = "ok";
  for (const item of items) {
    if (item.id == null) {
      // A buyer adds pack lines only; choosing a unit is its own ruling (SA-407).
      if ((item.unitLabel ?? "").trim() !== "")
        return { conflict: "A new line can't be sold by a unit from here" };
      verdict = "shape";
      continue;
    }
    const removal = item.action === "CANCEL" || item.action === "DELETE";
    const line = byId.get(item.id);
    if (removal) {
      // SA-507b: a removal names a line of THIS order — a foreign id is a 400 "shape" (one code, no
      // existence oracle), never a bare-id write the merge branch would apply to another order.
      if (!line) {
        verdict = "shape";
        continue;
      }
      const extra =
        item.qty !== undefined ||
        item.boxes != null ||
        item.pieces != null ||
        item.unitPrice !== undefined ||
        item.substituteProductId != null;
      if (extra) verdict = "shape";
      continue;
    }
    if (!isUnitAwareLine(line)) {
      verdict = "shape"; // a pack line: buyers edit those through the full replace
      continue;
    }
    if (item.boxes != null || item.pieces != null)
      return { conflict: `A line sold by the ${line!.unitLabel} takes a count, not boxes/pieces` };
    if (item.unitLabel !== line!.unitLabel)
      return { conflict: `This line is sold by the ${line!.unitLabel}; its unit can't be changed` };
    const priced =
      item.unitPrice !== undefined ||
      item.overrideReason != null ||
      item.substituteProductId != null ||
      item.name != null ||
      (item.action != null && item.action !== "UPDATE") ||
      (item.productId != null && item.productId !== line!.productId);
    if (priced || typeof item.qty !== "number") verdict = "shape";
  }
  return verdict;
}

/**
 * `updateOrderItems` entry guard. CUSTOMER/DRIVER branches still re-derive the factor + price from
 * the LIVE product, so an order with a unit-aware line refuses them — EXCEPT a diff of ONLY
 * CANCEL/DELETE entries, which just strikes lines off (no factor, no price) and is the only way a
 * non-staff caller can remove a mistaken Case line. A buyer's ownership is settled FIRST
 * (`findOwner`): the refusal names a unit on THIS order, which a non-owner must never learn.
 *
 * units_v1 (A1): a STAFF principal (OPERATOR/TENANT_ADMIN) is CONVERTED, not guarded, for every
 * shape EXCEPT `replaceAll: true`: a full replace re-denominates every existing line by matching
 * `productId` alone (see `updateOrderItems`'s replace-all branch), which would silently collapse a
 * Case line to the pack's price the moment the client's replace payload carries no line ids (the
 * B606 shape — a Case at $480 becomes a pack at $42, unnoticed). So a staff replaceAll is refused,
 * same as CUSTOMER/DRIVER, whenever the order already holds a unit-aware line — regardless of
 * whether `flag.units_v1` is still on for this tenant (a line already sold by a unit must never be
 * silently downgraded, flag or no flag). Every OTHER staff shape (diff add/update/substitute) stays
 * fully converted — those sites resolve each line's own factor via `resolveLineUnits`, never the
 * live product (see `unit-line-edit.ts`).
 */
export async function assertOrderEditAllowed(
  order: {
    customerId: string;
    lineItems: ReadonlyArray<LineLike & { id: string; productId?: string | null }>;
  },
  dto: EditDto,
  user: { role?: string } | undefined,
  findOwner: () => Promise<{ id: string } | null>,
): Promise<void> {
  if (user?.role === "OPERATOR" || user?.role === "TENANT_ADMIN") {
    if (dto.replaceAll === true) assertNoUnitAwareLines(order.lineItems, "replaced wholesale");
    return;
  }
  const items = dto.items ?? [];
  const strikeOffOnly =
    dto.replaceAll === false &&
    items.length > 0 &&
    items.every((i) => i.id != null && (i.action === "CANCEL" || i.action === "DELETE"));
  const buyer = user?.role === "CUSTOMER";
  const verdict = buyer ? buyerLineDiffVerdict(order.lineItems, dto) : "shape";
  const hasUnitLine = order.lineItems.some(isUnitAwareLine);
  if (strikeOffOnly || (!hasUnitLine && typeof verdict !== "object")) return;
  if (buyer) {
    // Ownership FIRST: a refusal names a unit on THIS order, which a non-owner must never learn.
    const owner = await findOwner();
    if (!owner || owner.id !== order.customerId) throw new ForbiddenException();
    // SA-407: the buyer per-line diff of a unit line (count up/down, remove) is converted.
    if (verdict === "ok") return;
    if (typeof verdict === "object")
      throw new ConflictException({
        code: UNIT_AWARE_LINE,
        message: `${verdict.conflict}. Edit it from the web order screen or ask the seller.`,
      });
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
 * (recomputeOrderFromInvoices) writes this edit straight onto the order line that does. The
 * invoice's own unit rows are judged only when it is order-linked (VU-4a); the parent is still
 * read either way so an unreadable one fails closed.
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
      code: API_ERROR_CODES.UNIT_AWARE_LINE_UNVERIFIABLE,
      message: "This invoice's lines could not be verified, so it can't be edited. Ask an admin.",
    });
  }
  // VU-4a (D3): an ORDER-LESS draft's own unit rows are rewritten by update() through resolveLineUnits;
  // nothing back-syncs them onto an order line. A linked draft keeps the full refusal.
  assertNoUnitAwareLines(
    [
      ...((invoice.orderId ? (own.items ?? []) : []) as LineLike[]),
      ...((linked?.lineItems ?? []) as LineLike[]),
    ],
    "edited",
  );
}
