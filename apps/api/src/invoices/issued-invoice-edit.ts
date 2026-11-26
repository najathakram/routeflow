import {
  inPlacePatch,
  invoiceHeaderData,
  isNoOpEdit,
  orderSyncLines,
  type EditedLine,
} from "./invoice-edit-plan";
import {
  assertEditableUnderLock,
  intakeMoney,
  type IssuedEditCtx,
  type LockedInvoiceForEdit,
} from "./locked-invoice-edit";
import { stampEditedPositions } from "./invoice-line-position";
import { roundMoney } from "@routeflow/pricing";

/**
 * SA-1508 A2-HOMES: the in-place edit of an ISSUED invoice lives here, never in `InvoiceService`'s body (size ratchet).
 *
 * A save that moves no money is FIGURE-FREE (A2-N1): both edit screens send every line, discount and shipping on every
 * save, so the save is figure-free exactly when nothing a customer is billed changes: no line dropped or added, every
 * line untouched (`orderSyncLines(...) === null`), discount and shipping equal to the locked row. It writes only the
 * header fields and the lines' `description`, `notes` and `position`, and runs NONE of the money machinery: no tax
 * guard, no sum, no ledger resync, no commission sync, no money gate. An older invoice whose stored tax does not
 * reproduce is therefore never refused for a notes or due-date change.
 *
 * Under the lock, in the caller's transaction. Returns the updated invoice (with `include`), or null when the save is
 * not figure-free (or is a DRAFT) and the caller continues with its own money path.
 */
const INCLUDE = {
  customer: { select: { id: true, businessName: true } },
  items: true,
  payments: true,
};

const LINE_KEYS = ["description", "notes", "position"] as const;

export async function writeIfFigureFree(
  tx: any,
  locked: LockedInvoiceForEdit,
  /** The items branch passes its edited lines; the header-only branch passes null (lines are not part of the save). */
  editLines: EditedLine[] | null,
  edit: IssuedEditCtx,
): Promise<any> {
  if (edit.mode !== "ISSUED") return null;
  const { invoice: cur } = locked;
  const discount = intakeMoney(edit.dto.discount, cur.discount);
  const shipping = intakeMoney(edit.dto.shippingFee, cur.shippingFee);
  const figureFree = editLines
    ? orderSyncLines(editLines, locked.storedRows, cur, discount, shipping) === null
    : roundMoney(discount - Number(cur.discount ?? 0)) === 0 &&
      roundMoney(shipping - Number(cur.shippingFee ?? 0)) === 0;
  if (!figureFree) return null;
  await assertEditableUnderLock(tx, locked, edit, { money: false });

  const patches: Array<{ id: string; data: Record<string, any> }> = [];
  if (editLines) {
    // W-1187: positions are stamped in memory exactly as the DRAFT path does (payload order, or the order's).
    await stampEditedPositions(
      tx,
      locked.storedRows,
      editLines,
      editLines.map((l) => l.data),
      cur.orderId,
    );
    for (const l of editLines) {
      const row = l.rowId ? locked.storedRows.find((r) => r.id === l.rowId) : undefined;
      const patch = row ? inPlacePatch(l, row) : null;
      if (!row || !patch) continue;
      const data = Object.fromEntries(
        LINE_KEYS.filter((k) => k in patch).map((k) => [k, patch[k]]),
      );
      if (Object.keys(data).length > 0) patches.push({ id: row.id, data });
    }
  }
  const headerData = invoiceHeaderData(edit.dto, edit.due, edit.issueDate);
  if (isNoOpEdit({ figureFree, linePatches: patches.length, headerData, row: cur })) {
    return tx.invoice.findUnique({ where: { id: cur.id }, include: INCLUDE });
  }
  for (const p of patches) await tx.invoiceItem.update({ where: { id: p.id }, data: p.data });
  return tx.invoice.update({
    where: { id: cur.id },
    data: { ...headerData, pdfUrl: null },
    include: INCLUDE,
  });
}
