import { BadRequestException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { UpdateOrderItemsDto } from "./dto/update-order-items.dto";

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
 * instead (price fields stripped just below), and a diff-shaped CUSTOMER
 * payload is rejected outright: no buyer client sends one (web+mobile buyer
 * portals send full {productId, qty} lists), and failing loudly beats
 * silently destroying the order's lines.
 */
/**
 * Mutates `dto.items` in place (the driver price-strip, when it applies) — matching the original
 * inline code's own behaviour exactly — and returns `isDiffPayload` for the two decisions the rest
 * of `updateOrderItems` still makes with it (restriction mode, the buyer/driver replace-branch test).
 */
export function classifyEditPayload(
  order: { lineItems: ReadonlyArray<{ id: string; productId?: string | null }> },
  dto: UpdateOrderItemsDto,
  user: { role?: string; sub?: string } | undefined,
): boolean {
  const isDiffPayload =
    dto.replaceAll === false ||
    (dto.items ?? []).some(
      (i) => i.id != null || i.action != null || i.substituteProductId != null,
    );
  if (user?.role === UserRole.CUSTOMER && isDiffPayload) {
    throw new BadRequestException(
      "Buyer edits must send the full item list as {productId, qty} entries; incremental item diffs are not supported on this path",
    );
  }
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
