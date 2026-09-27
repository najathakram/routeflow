import type { OrderItem } from "@/lib/api/orders";

/**
 * B718 / SA-388 (#938, tier 1): the ONE count function for a web unit line (edit-state seeding,
 * `originalQty`, `promoBaseUnits` and `buildItemUpdates`' comparison all go through it).
 * - `boxes` when it is a positive integer (unit-line-build.ts stores the COUNT there);
 * - else `qty ÷ unitsPerBox` — the line's SNAPSHOT factor — when `qty` (base pieces) is a
 *   positive whole multiple of it;
 * - else `null`: LOCKED. There is no safe count, so the line takes no qty edit and a price/note
 *   edit refuses to save (see findLockedUnitLineEdit). Falling back to raw `qty` read base pieces
 *   as the count — a price-only save re-billed a 3-Case line as 36 Cases (12×).
 *
 * Extracted from orders/[id]/page.tsx (size ratchet) — behavior unchanged.
 */
export function unitLineCount(li: Pick<OrderItem, "boxes" | "qty" | "unitsPerBox">): number | null {
  const boxes = li.boxes == null ? null : Number(li.boxes);
  if (boxes != null && Number.isInteger(boxes) && boxes > 0) return boxes;
  const factor = li.unitsPerBox == null ? null : Number(li.unitsPerBox);
  const qty = Number(li.qty);
  if (
    factor != null &&
    Number.isInteger(factor) &&
    factor >= 1 &&
    Number.isInteger(qty) &&
    qty > 0 &&
    qty % factor === 0
  ) {
    return qty / factor;
  }
  return null;
}

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
