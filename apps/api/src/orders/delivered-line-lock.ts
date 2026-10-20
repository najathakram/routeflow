import { ConflictException } from "@nestjs/common";
import { OrderStatus } from "@prisma/client";
import { withinStaffOverrideTolerance } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { orderEditMode } from "./order-edit-restrictions";

/**
 * B1234 (owner ruling 2026-10-03, D-O2-a / SA-648, "T3 lock delivered lines"): on a PARTIALLY_DELIVERED
 * order the office has exactly three actions (schedule the rest, invoice what was delivered, close the rest
 * as short). A line that has been delivered is LOCKED: nobody, through any entry point, may change its
 * quantity, price or unit, substitute it, strike it off or delete it. Full edit was refused because of the
 * stock and invoice risk of rewriting a line the goods already left on.
 *
 * ONE predicate, ONE guard. Every writer of an EXISTING order line on such an order goes through
 * `assertDeliveredLinesUntouched` (orders.delivered-line-lock.writer-pin.spec.ts pins the closed list of
 * writers). `updateOrderItems` runs it twice, on the pre-tx read (before any side effect) and on the
 * Order-locked read (the authoritative lines), so a delivery that landed while the edit waited on the lock
 * is judged too.
 *
 * Scope, exactly: ONLY `PARTIALLY_DELIVERED`. DELIVERED, OUT_FOR_DELIVERY and the earlier statuses keep
 * their existing edit rules untouched. Allowed on a delivered line: a note, an override reason with no
 * price change, a rename of an unlisted line (none of them quantity, price or unit). Allowed on the order:
 * every edit of an UNDELIVERED line, and a brand-new line. Pure: no Prisma, no Nest beyond the 409.
 */

export const DELIVERED_LOCK_STATUSES: readonly OrderStatus[] = [OrderStatus.PARTIALLY_DELIVERED];

export const DELIVERED_LINE_LOCKED_MESSAGE =
  "A delivered line can't be changed or removed. The lines that haven't been delivered can still be edited.";

/** The line columns the guard reads (the locked read `heldLinesOf` selects every one). */
export interface DeliveredLockLine {
  id: string;
  productId?: string | null;
  qty?: unknown;
  boxes?: number | null;
  pieces?: number | null;
  unitLabel?: string | null;
  unitPrice?: unknown;
  deliveredQty?: unknown;
}

/** The slice of one payload entry the guard reads (the DTO's `UpdateOrderItemDto`). */
export interface DeliveredLockEntry {
  id?: string;
  orderItemId?: string;
  action?: "CANCEL" | "DELETE" | "UPDATE";
  productId?: string;
  substituteProductId?: string;
  unitLabel?: string | null;
  qty?: number;
  boxes?: number;
  pieces?: number;
  unitPrice?: number;
  name?: string;
  notes?: string;
  overrideReason?: string | null;
}

/** True when the order status is one the delivered-line lock applies to. */
export const deliveredLockApplies = (status: string | null | undefined): boolean =>
  DELIVERED_LOCK_STATUSES.includes(status as OrderStatus);

/** The one predicate for "this line has been delivered": any delivered quantity at all. */
export const isDeliveredLine = (line: { deliveredQty?: unknown }): boolean =>
  Number(line.deliveredQty ?? 0) > 0;

const QTY_EPS = 0.0005;

/**
 * Does this payload entry change the line's quantity, price or unit, substitute it, or remove it?
 * An entry that restates the stored values (the web page sends `qty` along with a note edit) is not a change.
 */
function entryTouchesLine(entry: DeliveredLockEntry, held: DeliveredLockLine): boolean {
  if (entry.action === "CANCEL" || entry.action === "DELETE") return true;
  if (entry.substituteProductId != null) return true;
  if (entry.productId != null && entry.productId !== (held.productId ?? null)) return true;
  // `unitLabel: null` (clearing a unit) is not read as a change here: it is refused later, whatever the line's
  // status, by SA-474 (`assertNoPackRedenomination`, unit-line-edit.ts), before the binding check runs.
  if (entry.unitLabel != null && entry.unitLabel !== (held.unitLabel ?? null)) return true;
  // The half-cent band is pricing's (no-override-band-tokens.spec.ts): the money columns are 2 dp.
  if (
    entry.unitPrice != null &&
    !withinStaffOverrideTolerance(Number(entry.unitPrice), Number(held.unitPrice ?? 0))
  )
    return true;
  const splitEntered = (entry.boxes ?? 0) > 0 || (entry.pieces ?? 0) > 0;
  if (splitEntered) {
    return (entry.boxes ?? 0) !== (held.boxes ?? 0) || (entry.pieces ?? 0) !== (held.pieces ?? 0);
  }
  if (entry.qty != null) {
    // A unit-aware line stores its COUNT in `boxes` (units_v1); every other line's quantity is `qty`.
    const stored = held.unitLabel != null ? Number(held.boxes ?? 0) : Number(held.qty ?? 0);
    return Math.abs(entry.qty - stored) > QTY_EPS;
  }
  return false;
}

/**
 * The B1234 guard. Throws 409 LINE_ALREADY_DELIVERED, before any write, when `order.status` is
 * PARTIALLY_DELIVERED and the edit would touch a delivered line in `held`:
 *  - a per-line (merge) payload naming a delivered line with a quantity / price / unit change, a
 *    substitution, a CANCEL or a DELETE;
 *  - a replace (replace-all, or a driver / buyer full-list save), which deletes every line and re-creates
 *    them, whenever the order holds any delivered line (fail closed: the delete itself is the removal).
 * Any other status returns at once. `held` is the order's CURRENT lines (the locked read inside the tx).
 */
export function assertDeliveredLinesUntouched(
  order: { status: string },
  held: readonly DeliveredLockLine[],
  dto: { items?: readonly DeliveredLockEntry[]; replaceAll?: boolean },
  user: { role?: string } | undefined,
  isDiffPayload: boolean,
): void {
  if (!deliveredLockApplies(order.status)) return;
  const delivered = held.filter(isDeliveredLine);
  if (delivered.length === 0) return;

  const mode = orderEditMode(user?.role, dto.replaceAll, isDiffPayload);
  if (mode.kind === "replace") throw deliveredLineLocked();

  const deliveredById = new Map(delivered.map((l) => [l.id, l]));
  for (const entry of dto.items ?? []) {
    const id = entry.id ?? entry.orderItemId;
    const line = id ? deliveredById.get(id) : undefined;
    if (line && entryTouchesLine(entry, line)) throw deliveredLineLocked();
  }
}

/**
 * The fields a payload entry for a delivered line may carry once the guard has let it through: the line's
 * identity, a note, an override reason and (for an unlisted line) a rename. Nothing else.
 */
const DELIVERED_LINE_ALLOWED_FIELDS = [
  "id",
  "orderItemId",
  "action",
  "name",
  "notes",
  "overrideReason",
] as const;

/**
 * B1234 (binding stage). The guard lets through an entry that RESTATES a delivered line (the web page sends
 * `qty`, the box split and `unitPrice` along with every note edit). Letting the restated fields reach the write
 * loop would still reprice the line: `rescaleBogoFreeUnits` reads the LIVE promotions, a box split without a
 * snapshot is re-derived from the LIVE product, a unit line is re-priced from the live ladder. So, on a
 * delivered-lock order, an entry that names a delivered line is reduced to the fields above before any write; it
 * then takes the notes-only path (or, carrying none of them, writes nothing). Returns the same array when
 * nothing applies. Call it AFTER `assertDeliveredLinesUntouched` on the locked lines (a refusal never reaches it).
 */
export function reduceDeliveredLineEntries<T extends DeliveredLockEntry>(
  order: { status: string },
  held: readonly DeliveredLockLine[],
  items: T[] | undefined,
): T[] | undefined {
  if (!items || !deliveredLockApplies(order.status)) return items;
  const deliveredIds = new Set(held.filter(isDeliveredLine).map((l) => l.id));
  if (deliveredIds.size === 0) return items;
  return items.map((entry) => {
    const id = entry.id ?? entry.orderItemId;
    if (!id || !deliveredIds.has(id)) return entry;
    const reduced: Record<string, unknown> = {};
    for (const key of DELIVERED_LINE_ALLOWED_FIELDS) {
      if (entry[key] !== undefined) reduced[key] = entry[key];
    }
    return reduced as T;
  });
}

function deliveredLineLocked(): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.LINE_ALREADY_DELIVERED,
    message: DELIVERED_LINE_LOCKED_MESSAGE,
  });
}
