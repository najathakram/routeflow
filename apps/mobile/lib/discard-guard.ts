/**
 * Discard-guard predicates (hunt-mobile-scan, lane discard-guard, RULINGS.md R4).
 *
 * Pure logic only — no React/RN imports — so it is importable from Jest with
 * no renderer. Every predicate here answers "would leaving right now lose
 * something the operator typed?" for one FormSheet-based screen (or, for
 * `hasUnsavedInvoiceDraft`, the composer screen that has no FormSheet at
 * all). Callers pass the result as `FormSheet`'s `confirmDiscardIfDirty`
 * prop (see `components/FormSheet.tsx`), or gate their own back handler with
 * it directly.
 *
 * `shouldConfirmDiscard` is the generic form: dirty AND NOT mid-submit — a
 * screen already saving must never also prompt "discard?" on the same tap.
 */

/** Generic gate: never prompt on a clean form, and never prompt mid-submit. */
export function shouldConfirmDiscard(dirty: boolean, submitting: boolean): boolean {
  return dirty && !submitting;
}

/** standing-orders/new.tsx: a named template or any added line is losable work. */
export function hasUnsavedStandingOrder(input: {
  name: string;
  lines: ReadonlyArray<unknown>;
}): boolean {
  return input.name.trim().length > 0 || input.lines.length > 0;
}

/**
 * invoices/new.tsx (InvoiceComposer): a selected catalog item or an added
 * unlisted line is losable work. The CustomerPicker stage that precedes the
 * composer is intentionally NOT covered here — it renders before `items`/
 * `unlisted` can hold anything, so it has nothing to lose.
 */
export function hasUnsavedInvoiceDraft(input: {
  items: Record<string, unknown>;
  unlisted: ReadonlyArray<unknown>;
}): boolean {
  return Object.keys(input.items).length > 0 || input.unlisted.length > 0;
}

/**
 * A single edited invoice line, as tracked by invoices/[id]/edit.tsx's
 * `EditLine` state. Deliberately omits `key` (React-local identity),
 * `unitsPerBox` (a catalog fact, not user-entered), `taxRate` (the stored
 * historic rate, not something the operator types here), and
 * `promoFreeUnits`/`promoBaseUnits` (a carried-over snapshot, not an edit
 * surface on this screen) — only user-entered money/description state is
 * compared. `noteOpen` is UI expand/collapse state, not data, and is not
 * compared by `hasUnsavedInvoiceLineEdits` even though it may be present.
 *
 * NOTE: if `EditLine` in edit.tsx gains a new user-editable field, add it
 * here and to the comparison in `hasUnsavedInvoiceLineEdits` too, or a real
 * edit can silently stop being detected as dirty.
 */
export interface InvoiceEditLineSnapshot {
  productId: string | null;
  description: string;
  qty: number;
  boxes: number | null;
  pieces: number | null;
  unitPrice: number | null;
  discount: number | null;
  taxable: boolean;
  note: string;
  noteOpen?: boolean;
}

/** Full edit.tsx form snapshot: every line plus every header field. */
export interface InvoiceEditSnapshot {
  lines: ReadonlyArray<InvoiceEditLineSnapshot>;
  issueDate: string;
  dueDate: string;
  invDiscount: number | null;
  shippingFee: number | null;
  referenceNumber: string;
  subject: string;
  notes: string;
  terms: string;
}

function sameInvoiceEditLine(a: InvoiceEditLineSnapshot, b: InvoiceEditLineSnapshot): boolean {
  return (
    a.productId === b.productId &&
    a.description === b.description &&
    a.qty === b.qty &&
    a.boxes === b.boxes &&
    a.pieces === b.pieces &&
    a.unitPrice === b.unitPrice &&
    a.discount === b.discount &&
    a.taxable === b.taxable &&
    a.note === b.note
  );
}

/**
 * invoices/[id]/edit.tsx: compares the live form against the snapshot taken
 * at hydration. `original === null` means the form has not hydrated yet
 * (or the invoice isn't a DRAFT, so the effect never ran) — never treat an
 * un-hydrated form as dirty.
 */
export function hasUnsavedInvoiceLineEdits(
  current: InvoiceEditSnapshot,
  original: InvoiceEditSnapshot | null,
): boolean {
  if (!original) return false;

  if (
    current.issueDate !== original.issueDate ||
    current.dueDate !== original.dueDate ||
    current.invDiscount !== original.invDiscount ||
    current.shippingFee !== original.shippingFee ||
    current.referenceNumber !== original.referenceNumber ||
    current.subject !== original.subject ||
    current.notes !== original.notes ||
    current.terms !== original.terms
  ) {
    return true;
  }

  if (current.lines.length !== original.lines.length) return true;
  for (let i = 0; i < current.lines.length; i += 1) {
    if (!sameInvoiceEditLine(current.lines[i], original.lines[i])) return true;
  }
  return false;
}

/**
 * purchase-orders/[id]/receive.tsx: every field is pre-seeded from the PO's
 * remaining quantity, so an untouched screen already displays (and would
 * submit) a full receipt with zero typing. "Touched" is presence of the
 * itemId as an own key in one of the three maps — matching the screen's own
 * seed-fallback design — NOT equality to the seeded value; tapping a field
 * and typing the same digits back still counts as touched. That is an
 * accepted false-positive trade-off (see design risk notes) rather than a
 * more complex value-vs-seed comparison.
 */
export function hasTouchedReceiveForm(input: {
  qtys: Record<string, string>;
  boxQtys: Record<string, string>;
  pieceQtys: Record<string, string>;
  notes: string;
}): boolean {
  return (
    Object.keys(input.qtys).length > 0 ||
    Object.keys(input.boxQtys).length > 0 ||
    Object.keys(input.pieceQtys).length > 0 ||
    input.notes.trim().length > 0
  );
}

/**
 * payments/record.tsx: any non-blank field, any attached photo, or the
 * as-draft toggle counts as unsaved work. `allocs` is deliberately excluded
 * — it is a pure function of `amount` via the waterfall pre-fill, so
 * checking `amount` alone avoids double-counting the same edit.
 */
export function hasUnsavedPayment(input: {
  amount: string;
  reference: string;
  notes: string;
  bankCharges: string;
  paidAt: string;
  settledAt: string;
  photos: ReadonlyArray<unknown>;
  asDraft: boolean;
}): boolean {
  return (
    input.amount.trim().length > 0 ||
    input.reference.trim().length > 0 ||
    input.notes.trim().length > 0 ||
    input.bankCharges.trim().length > 0 ||
    input.paidAt.trim().length > 0 ||
    input.settledAt.trim().length > 0 ||
    input.photos.length > 0 ||
    input.asDraft
  );
}
