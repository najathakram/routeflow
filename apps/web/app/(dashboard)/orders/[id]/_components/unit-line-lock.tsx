import { invoiceLineQtyText } from "@routeflow/pricing";
import type { OrderItem } from "@/lib/api/orders";

// B718 / SA-388: the ONE count function for a unit line lives in @routeflow/pricing (#2276 —
// web and mobile imported drifting copies); re-exported so this page's imports stay unchanged.
export { unitLineCount } from "@routeflow/pricing";

/** Thrown by buildItemUpdates if a LOCKED unit line's edit ever reaches it (SA-388 backstop —
 *  the save handlers refuse first via findLockedUnitLineEdit, so no request is ever built). */
export class LockedUnitLineError extends Error {
  constructor(readonly lineName: string) {
    super(`${lineName} needs repair before it can be edited`);
    this.name = "LockedUnitLineError";
  }
}

/** The edit-state fields findLockedUnitLineEdit reads (a structural slice of EditItemState). */
export interface LockableEditLine {
  id: string;
  isNew?: boolean;
  cancelled: boolean;
  countLocked?: boolean;
  unitPrice: number;
  notes?: string;
  qty: number;
  originalQty: number;
  substituteProductId?: string;
}

/**
 * SA-388: the first LOCKED unit line (no derivable count) that this session changed — its price,
 * note, qty or a substitution. Cancelling is still allowed (it sends no qty). Both save paths
 * call this BEFORE building a payload and refuse with a visible message when it returns a line.
 */
export function findLockedUnitLineEdit<T extends LockableEditLine>(
  items: T[],
  original: OrderItem[],
): T | undefined {
  return items.find((edited) => {
    if (!edited.countLocked || edited.isNew || edited.cancelled) return false;
    const orig = original.find((li) => li.id === edited.id);
    if (!orig) return false;
    const priceChanged = Math.abs(edited.unitPrice - Number(orig.unitPrice)) > 0.0001;
    const noteChanged = (edited.notes ?? "").trim() !== ((orig.notes as string) ?? "").trim();
    const qtyChanged = Math.abs(edited.qty - edited.originalQty) > 0.0001;
    return priceChanged || noteChanged || qtyChanged || !!edited.substituteProductId;
  });
}

type SplitLine = Pick<OrderItem, "qty" | "boxes" | "pieces" | "unitsPerBox" | "unitLabel">;

/**
 * #2266 (SA-388d): the ONLY repair shape — a unit line (unitLabel set, factor > 1, qty > 0) whose
 * boxes AND pieces are both 0/null. The same predicate as the DB CHECK and the api's
 * `isEmptyUnitLineSplit` (unit-line-split.ts). A factor-1 "Each" line stores no split, so it is
 * exempt, as are pack lines (no unitLabel) and zero-qty rows.
 */
export function isEmptyUnitLineSplit(li: SplitLine): boolean {
  if (li.unitLabel == null) return false;
  const factor = li.unitsPerBox == null ? 1 : Number(li.unitsPerBox);
  if (!(factor > 1)) return false;
  if (!(Number(li.qty) > 0)) return false;
  return !(Number(li.boxes ?? 0) >= 1) && !(Number(li.pieces ?? 0) >= 1);
}

export interface LockedUnitLineDisplay {
  needsRepair: boolean;
  /** "3 Cases + 4 pcs" for a valid partial line; null when it needs repair. */
  text: string | null;
}

/**
 * #2266: what a LOCKED unit line shows. A valid partial Case (SA-178 / B652: a legitimate
 * physical quantity) reads as whole units + remainder of its base pieces, through the shared
 * `invoiceLineQtyText` formatter; only SA-388d's all-empty split reads "needs repair".
 */
export function lockedUnitLineDisplay(li: SplitLine): LockedUnitLineDisplay {
  if (isEmptyUnitLineSplit(li)) return { needsRepair: true, text: null };
  const qty = Math.max(0, Math.round(Number(li.qty)));
  const factor = li.unitsPerBox == null ? 1 : Math.max(1, Math.round(Number(li.unitsPerBox)));
  const boxes = Math.floor(qty / factor);
  return {
    needsRepair: false,
    text: invoiceLineQtyText({ qty, boxes, pieces: qty - boxes * factor, unitLabel: li.unitLabel }),
  };
}

/** #2266: the save-refusal message for a LOCKED unit line (the refusal itself is unchanged). */
export function lockedUnitLineRefusal(name: string, display?: LockedUnitLineDisplay): string {
  return display && !display.needsRepair
    ? `${name} is a partial quantity (${display.text}) and can't be edited as a count — cancel it and add the line again to change it. Nothing was saved.`
    : `${name} needs repair — its stored quantity can't be read as a count, so it can't be edited. Nothing was saved.`;
}

/** SA-388 / #2266: the row marker a LOCKED unit line shows in place of its qty input. */
export function LockedUnitLineBadge({ display }: { display?: LockedUnitLineDisplay }) {
  if (display && !display.needsRepair) {
    return (
      <span
        role="status"
        title="A partial quantity can't be edited as a count. Cancel the line and add it again to change it."
        className="shrink-0 rounded-full bg-sunken px-2 py-0.5 text-[11px] font-medium text-navy/80 ring-1 ring-line"
      >
        {display.text}
      </span>
    );
  }
  return (
    <span
      role="status"
      title="This line's stored quantity can't be read as a count. It can be cancelled, but not edited, until it's repaired."
      className="shrink-0 rounded-full bg-danger-bg px-2 py-0.5 text-[11px] font-medium text-danger ring-1 ring-danger/30"
    >
      This line needs repair
    </span>
  );
}
