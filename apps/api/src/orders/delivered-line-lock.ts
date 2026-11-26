import { BadRequestException, ConflictException } from "@nestjs/common";
import { OrderStatus } from "@prisma/client";
import { withinStaffOverrideTolerance } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import {
  CORRECT_IDENTITY_MESSAGE,
  CORRECT_WITH_RETURN_MESSAGE,
  OPERATOR_BELOW_MESSAGE,
  OPERATOR_NOTE,
  OPERATOR_REMOVED_MESSAGE,
  lockedCopy,
  statusCopy,
} from "./delivered-line-copy";
import type { LineEditDecision } from "./delivered-line-edit-mode";
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
 * Scope, exactly: the full change lock is ONLY `PARTIALLY_DELIVERED`. DELIVERED, OUT_FOR_DELIVERY and the earlier
 * statuses keep their existing edit rules, with one exception (SA-1101 §2.7, verification F): REMOVING a delivered
 * line (strike-off, delete, substitution) is refused on every status. Allowed on a delivered line: a note, an override reason with no
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
  /** SA-1533 (s): 0 only, with a take-off only. */
  deliveredTo?: number;
  /** SA-1546 M2: an admin's opt-in to apply the server's delivered correction to a quantity, box or piece change (true only). */
  correctDelivered?: true;
  boxes?: number;
  pieces?: number;
  unitPrice?: number;
  name?: string;
  notes?: string;
  overrideReason?: string | null;
}

/**
 * SA-1506 PR-1a: the per-line decisions of `deliveredLineEditMode` (delivered-line-facts.ts), by line id. An empty map is
 * the pre-SA-1506 behaviour (no CORRECT line, every refusal in today's words), which every caller without the order-level
 * facts keeps.
 */
export type DeliveredModes = ReadonlyMap<string, LineEditDecision>;
const NO_MODES: DeliveredModes = new Map();
const EDIT: LineEditDecision = { mode: "EDIT" };

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
export function entryTouchesLine(entry: DeliveredLockEntry, held: DeliveredLockLine): boolean {
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
  return entryChangesQuantity(entry, held);
}

/**
 * SA-1546 M3: does the entry AS SENT change the line's quantity, box split or piece count? Judged on the request against
 * the held line, never on the row after the write (a legacy non-canonical split is rewritten by the write loop, so the after
 * row can differ from the held one although the entry said nothing about quantity). A price, a note, a restated quantity: no.
 */
export function entryChangesQuantity(entry: DeliveredLockEntry, held: DeliveredLockLine): boolean {
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
  dto: { items?: readonly DeliveredLockEntry[]; replaceAll?: boolean; inlineReturn?: unknown },
  user: { role?: string } | undefined,
  isDiffPayload: boolean,
  modes: DeliveredModes = NO_MODES,
): void {
  const delivered = held.filter(isDeliveredLine);
  if (delivered.length === 0) return;

  const mode = orderEditMode(user?.role, dto.replaceAll, isDiffPayload);
  const deliveredById = new Map(delivered.map((l) => [l.id, l]));
  const decisionOf = (id: string): LineEditDecision => modes.get(id) ?? EDIT;
  const isCorrect = (id: string) => decisionOf(id).mode === "CORRECT";
  if (mode.kind === "merge") {
    // SA-1506: an admin's CORRECT line is judged by the correction's own rules, on every status (the lock below skips it).
    for (const entry of dto.items ?? []) {
      const id = entry.id ?? entry.orderItemId;
      const line = id ? deliveredById.get(id) : undefined;
      if (line && isCorrect(line.id)) assertCorrectEntry(entry, line, dto);
    }
  }
  if (!deliveredLockApplies(order.status)) {
    // SA-1101 §2.7 (verification F): off a PARTIALLY_DELIVERED order only the full change lock stays off. Taking a
    // delivered line away is refused on every status; goods come back through a return. Replace mode keeps
    // SA-763r's carry (a replace never removes a delivered line, it re-creates it).
    if (mode.kind === "merge") {
      for (const entry of dto.items ?? []) {
        const id = entry.id ?? entry.orderItemId;
        if (id && deliveredById.has(id) && !isCorrect(id) && entryRemovesLine(entry))
          throw deliveredLineRemoved(decisionOf(id));
      }
    }
    return;
  }
  if (mode.kind === "replace") throw deliveredLineLocked(EDIT);

  for (const entry of dto.items ?? []) {
    const id = entry.id ?? entry.orderItemId;
    const line = id ? deliveredById.get(id) : undefined;
    if (line && !isCorrect(line.id) && entryTouchesLine(entry, line))
      throw deliveredLineLocked(decisionOf(line.id));
  }
}

/** CORRECT restates quantity, box split and price, or takes the line off. It never changes what the line IS. */
function assertCorrectEntry(
  entry: DeliveredLockEntry,
  held: DeliveredLockLine,
  dto: { inlineReturn?: unknown },
): void {
  const unitChange =
    typeof entry.unitLabel === "string" &&
    entry.unitLabel.trim() !== "" &&
    entry.unitLabel !== (held.unitLabel ?? null);
  const productChange = entry.productId != null && entry.productId !== (held.productId ?? null);
  if (entry.substituteProductId != null || productChange || unitChange)
    throw conflict(CORRECT_IDENTITY_MESSAGE);
  // SA-1533 (s): a take-off is a correction only when it says so (`deliveredTo: 0`); a bare DELETE / CANCEL (the mobile
  // screen, old builds) keeps master's removal 409, so a phone cannot restock a delivered line by trashing it.
  if (entryRemovesLine(entry) && entry.deliveredTo !== 0) throw deliveredLineRemoved(EDIT);
  // SA-1546 M2: a quantity, box or piece change is a correction only when it says so (`correctDelivered: true`, the admin's
  // confirm on the web). Without it the answer is master's lock 409, so mobile and old builds never restate a delivered line.
  if (
    !entryRemovesLine(entry) &&
    entry.correctDelivered !== true &&
    entryChangesQuantity(entry, held)
  )
    throw deliveredLineLocked(EDIT);
  // A return and a correction read the order's stock differently: one save does one of them (SA-1506 C2).
  if (dto.inlineReturn != null && entryTouchesLine(entry, held))
    throw conflict(CORRECT_WITH_RETURN_MESSAGE);
}

/** SA-1533 (s): `deliveredTo` is 0 and only with a take-off; anything else is a 400 before any read or write. */
export function assertDeliveredToShape(items: ReadonlyArray<DeliveredLockEntry> | undefined): void {
  for (const entry of items ?? []) {
    if (entry.deliveredTo == null) continue;
    if (entry.deliveredTo !== 0 || !(entry.action === "CANCEL" || entry.action === "DELETE"))
      throw new BadRequestException("Delivered can only be set to 0, when taking a line off.");
  }
}

const conflict = (message: string) =>
  new ConflictException({ code: API_ERROR_CODES.LINE_ALREADY_DELIVERED, message });

/**
 * The words of one refusal. An OPERATOR who could be told an admin can correct this line gets the admin sentence; a
 * line locked for a named reason (never ROLE, never UNIT, which keep today's words) says that reason's copy; otherwise
 * today's text stands.
 */
function refusalWords(decision: LineEditDecision, today: string, operator: string): string {
  if (decision.mode !== "LOCKED") return today;
  if (decision.reason === "ROLE") return decision.operatorNote ? operator : today;
  if (decision.reason === "UNIT") return today;
  if (decision.reason === "STATUS") return statusCopy(decision.status);
  return lockedCopy(decision.reason, { invoiceNumber: decision.invoiceNumber });
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

/** A CORRECT entry keeps its real changes; a price or unit label equal to the held line's is dropped (same entry if none). */
/**
 * SA-1536 (ad): the write loop reaches an existing line's price only through a quantity, a box split, a note or a reason;
 * a bare `{ id, unitPrice }` is silently dropped (the web always sends the quantity along). A price-only entry on a
 * CORRECT line therefore carries the line's own quantity, so the price is applied, never accepted and ignored.
 */
function withHeldQtyWhenPriceOnly<T extends DeliveredLockEntry>(
  entry: T,
  held: DeliveredLockLine,
): T {
  const priceOnly =
    entry.unitPrice != null &&
    entry.qty === undefined &&
    entry.boxes == null &&
    entry.pieces == null;
  const removes = entry.action === "CANCEL" || entry.action === "DELETE";
  if (!priceOnly || removes || held.qty == null) return entry;
  return { ...entry, qty: Number(held.qty) };
}

function withoutUnchangedPriceAndUnit<T extends DeliveredLockEntry>(
  entry: T,
  held: DeliveredLockLine,
): T {
  const samePrice =
    entry.unitPrice != null &&
    withinStaffOverrideTolerance(Number(entry.unitPrice), Number(held.unitPrice ?? 0));
  const sameUnit = entry.unitLabel != null && entry.unitLabel === (held.unitLabel ?? null);
  if (!samePrice && !sameUnit) return entry;
  const out = { ...entry } as Record<string, unknown>;
  if (samePrice) delete out.unitPrice;
  if (sameUnit) delete out.unitLabel;
  return out as T;
}

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
  modes: DeliveredModes = NO_MODES,
): T[] | undefined {
  if (!items) return items;
  const pd = deliveredLockApplies(order.status); // the full change lock: every delivered line is cut
  // A2 M8: on CONFIRMED and PARTIALLY_DELIVERED the strip is keyed per LIVE delivered line, for every role: an entry that
  // restates it (no real change) is cut, so it never reprices from live promotions or restates a sent invoice.
  const perLine = pd || order.status === OrderStatus.CONFIRMED;
  const deliveredLines = new Map(held.filter(isDeliveredLine).map((l) => [l.id, l]));
  const isCorrect = (id: string) => modes.get(id)?.mode === "CORRECT";
  if (deliveredLines.size === 0) return items;
  if (!perLine && ![...deliveredLines.keys()].some(isCorrect)) return items;
  const out = items.map((entry) => {
    const id = entry.id ?? entry.orderItemId;
    const line = id ? deliveredLines.get(id) : undefined;
    if (!id || !line) return entry;
    if (isCorrect(id)) {
      // B8: an admin's DELETE of a delivered line is a take-off (CANCEL): the row is kept, never removed.
      if (entry.action === "DELETE")
        return withoutUnchangedPriceAndUnit({ ...entry, action: "CANCEL" } as T, line);
      // B7: a real change reaches the write loop; a restated entry is cut to its note / reason below.
      // SA-1514 A3 LOW 9 (A1 B10): a price or unit the entry only restates is dropped on EVERY CORRECT entry, so it never
      // reprices a sent invoice from a stale price or trips the unit guards.
      if (entryTouchesLine(entry, line))
        return withHeldQtyWhenPriceOnly(withoutUnchangedPriceAndUnit(entry, line), line);
    } else if (!pd && !(perLine && isLiveDeliveredLine(line) && !entryTouchesLine(entry, line))) {
      return entry;
    }
    const reduced: Record<string, unknown> = {};
    for (const key of DELIVERED_LINE_ALLOWED_FIELDS) {
      if (entry[key] !== undefined) reduced[key] = entry[key];
    }
    return reduced as T;
  });
  return out.every((e, i) => e === items[i]) ? items : out; // the same array when nothing was cut
}

/** A per-line entry that takes a line away: a strike-off, a delete or a substitution (SA-1101 §2.7). */
const entryRemovesLine = (entry: DeliveredLockEntry): boolean =>
  entry.action === "CANCEL" || entry.action === "DELETE" || entry.substituteProductId != null;

export const DELIVERED_LINE_REMOVED_MESSAGE =
  "This line was delivered, so it can't be removed. To take goods back, record a return.";

function deliveredLineRemoved(decision: LineEditDecision): ConflictException {
  return conflict(refusalWords(decision, DELIVERED_LINE_REMOVED_MESSAGE, OPERATOR_REMOVED_MESSAGE));
}

function deliveredLineLocked(decision: LineEditDecision): ConflictException {
  return conflict(
    refusalWords(
      decision,
      DELIVERED_LINE_LOCKED_MESSAGE,
      `${DELIVERED_LINE_LOCKED_MESSAGE} ${OPERATOR_NOTE}`,
    ),
  );
}

export const DELIVERED_LINE_BELOW_MESSAGE =
  "This line's quantity can't be less than what was delivered. To take goods back, record a return.";

/**
 * SA-1149 (W-946r, SA-992 D2): the quantity floor. A write of an existing line's quantity may not land below what was
 * delivered, on any status. It refuses ONLY when the next qty is below BOTH the delivered qty and the line's held qty: a
 * note edit that restates an over-delivered line ({q2,d4} sent as 2) is not a cut. Pure: pass the FINAL stored qty in the
 * line's own unit (after `normalizeBoxesPieces`), so a box split or a unit line is judged on what is stored, never on
 * `item.qty`. Throws 409.
 */
export function assertQtyNotBelowDelivered(
  deliveredQty: unknown,
  heldQty: unknown,
  nextQty: unknown,
  decision: LineEditDecision = EDIT,
): void {
  const delivered = Number(deliveredQty ?? 0);
  if (!(delivered > 0)) return;
  if (decision.mode === "CORRECT") return; // SA-1506: an admin's correction may cut below what was delivered
  const next = Number(nextQty);
  if (next < delivered - QTY_EPS && next < Number(heldQty ?? 0) - QTY_EPS) {
    throw conflict(refusalWords(decision, DELIVERED_LINE_BELOW_MESSAGE, OPERATOR_BELOW_MESSAGE));
  }
}

/**
 * SA-1149 (round 2): an order holding a live delivered line is never a merge target and never a merge loser (a merge
 * folds by replace and deletes the loser's lines, so the delivered stamp would be lost, B1167). One fragment, read by
 * every `forMerge` search and by both branches of `mergeEligibleWhere`; `isLiveDeliveredLine` is its JS twin (a unit row
 * checks the two agree). Spread only inside a where that has no other `lineItems` key; otherwise use an `AND` (it shares the `lineItems` key with the unit-aware guard).
 */
export const ORDER_HAS_NO_LIVE_DELIVERED_LINE = {
  lineItems: { none: { deliveredQty: { gt: 0 }, status: { not: "CANCELLED" } } },
} as const;

/** The JS twin of `ORDER_HAS_NO_LIVE_DELIVERED_LINE`: a line that is not CANCELLED and has delivered something. */
export function isLiveDeliveredLine(line: { status?: unknown; deliveredQty?: unknown }): boolean {
  return line.status !== "CANCELLED" && Number(line.deliveredQty ?? 0) > 0;
}

/** True when any HELD line is a live delivered line: the third input of `resyncsInPlace` and the buyer window's second. */
export const holdsLiveDeliveredLine = (
  lines: ReadonlyArray<{ status?: unknown; deliveredQty?: unknown }> | undefined,
): boolean => (lines ?? []).some(isLiveDeliveredLine);
