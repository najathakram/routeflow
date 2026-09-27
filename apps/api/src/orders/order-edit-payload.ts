import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { UpdateOrderItemsDto } from "./dto/update-order-items.dto";
import { buyerLineDiffVerdict } from "./unit-aware-guard";

/**
 * `updateOrderItems`'s payload classification — lifted VERBATIM out of the method (size-ratchet
 * headroom for the units_v1 by-file conversion; #1139 already emptied the easy headroom out of
 * this file). Pure: no DB, no `this`, decides shape from the DTO/order alone. No behaviour change.
 *
 * A4: the mobile item editor is SHARED between the operator and driver screens
 * and always sends an incremental diff — {id, action} entries with
 * replaceAll:false — while the CUSTOMER/DRIVER branch below is a full replace
 * (deleteMany, then re-create only productId-carrying entries). A diff routed
 * through the replace branch therefore deleted every untouched line on the
 * order. Diff-shaped DRIVER payloads go through the operator merge branch
 * instead (price fields stripped just below). A diff-shaped CUSTOMER payload is
 * refused by `assertBuyerDiffShape` (below, run after the unit guard) unless it
 * is SA-407's per-line unit-count edit or a removal of this order's own line.
 */
/**
 * Mutates `dto.items` in place (the driver price-strip, when it applies) — matching the original
 * inline code's own behaviour exactly — and returns `isDiffPayload` for the two decisions the rest
 * of `updateOrderItems` still makes with it (restriction mode, the buyer/driver replace-branch test).
 */
export function classifyEditPayload(
  order: {
    lineItems: ReadonlyArray<{
      id: string;
      productId?: string | null;
      unitLabel?: string | null;
      status?: string | null;
    }>;
  },
  dto: UpdateOrderItemsDto,
  user: { role?: string; sub?: string } | undefined,
): boolean {
  const isDiffPayload =
    dto.replaceAll === false ||
    (dto.items ?? []).some(
      (i) => i.id != null || i.action != null || i.substituteProductId != null,
    );
  if (user?.role === UserRole.DRIVER && isDiffPayload) {
    // B13: non-staff never set prices. The merge branch honors per-line
    // unitPrice overrides for operators, so strip price fields from every
    // catalog-linked driver entry before it gets there — a fresh add prices
    // from the catalog and a qty edit keeps the line's stored price (which
    // may be an operator's override; a driver edit must not disturb it).
    // Unlisted (catalog-free) lines keep their client price: they have no
    // catalog price to fall back to, matching the replace branch's
    // long-standing unlisted handling.
    const unlistedLineIds = new Set(
      (order.lineItems ?? []).filter((li) => !li.productId).map((li) => li.id),
    );
    dto.items = (dto.items ?? []).map((i) => {
      const isUnlistedLine = i.id
        ? unlistedLineIds.has(i.id)
        : !i.productId && (i.name ?? "").trim() !== "";
      if (isUnlistedLine) return i;
      const { unitPrice: _unitPrice, overrideReason: _overrideReason, ...rest } = i;
      return rest;
    });
  }
  return isDiffPayload;
}

/**
 * SA-407 / SA-507b (#2272): the ONE buyer diff allowed is a unit line's count up/down (id + its own
 * stored unitLabel + qty) or a removal of one of THIS order's lines by id; every other buyer diff
 * is a 400. Called AFTER `assertOrderEditAllowed` (ownership first, then the 409 conflict shapes),
 * so it only ever answers "shape" — never a 409, and never to a non-owner (SA-507a: an auto-merge
 * once ran the old in-classifier throw ahead of the guard and turned every 409 into this 400).
 */
export async function assertBuyerDiffShape(
  order: { customerId: string; lineItems: Parameters<typeof buyerLineDiffVerdict>[0] },
  dto: UpdateOrderItemsDto,
  user: { role?: string } | undefined,
  isDiffPayload: boolean,
  findOwner: () => Promise<{ id: string } | null>,
): Promise<void> {
  if (user?.role !== UserRole.CUSTOMER || !isDiffPayload) return;
  if (buyerLineDiffVerdict(order.lineItems, dto) !== "shape") return;
  // Ownership FIRST (lead, #2561): a non-owner gets the bare 403, never this 400 as an oracle.
  const owner = await findOwner();
  if (!owner || owner.id !== order.customerId) throw new ForbiddenException();
  throw new BadRequestException(
    "Buyer edits must send the full item list as {productId, qty} entries; incremental item diffs are not supported on this path",
  );
}
