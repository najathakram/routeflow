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

/** SA-388: the row marker a LOCKED unit line shows in place of its qty input. */
export function LockedUnitLineBadge() {
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
