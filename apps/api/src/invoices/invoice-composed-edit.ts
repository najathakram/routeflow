import { ConflictException, BadRequestException } from "@nestjs/common";
import { componentUnitPrice4, roundMoney } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { rescaleComposition } from "../orders/line-composition";

interface EditedLineLike {
  rowId: string | null;
  untouched: boolean;
  data: Record<string, any>;
}

const refuse = (message: string) =>
  new ConflictException({ code: API_ERROR_CODES.COMPOSED_LINE_EDIT, message });

/**
 * #2717 M3 (SA-579 case 18, Q6): keep the component rows of a composed invoice line in step with a
 * DRAFT edit, in the edit's own tx, after the line rows were written.
 * - Only a DRAFT invoice's component rows are ever written (anything else is refused up front).
 * - An untouched line, or an edit with no composed stored row, writes nothing (ids stay put).
 * - A price change re-stamps `displayUnitPrice4` on the line's own net over its pieces.
 * - A WHOLE-BOX quantity change (old and new both whole boxes, no loose pieces) rebuilds the rows
 *   from the stored ones (`rescaleComposition`, no Recipe read), re-priced on the new net.
 * - Any other quantity change is a 409 COMPOSED_LINE_EDIT: the frozen composition cannot be guessed.
 * Nested rows carry the tenantId explicitly (nested/many writes are not tenant-injected).
 */
export async function applyComposedLineEdits(
  tx: any,
  inv: { id: string; status: string; tenantId: string | null },
  editLines: EditedLineLike[],
  storedRows: Array<Record<string, any>>,
): Promise<void> {
  const composed = new Map(
    storedRows.filter((r) => r.compositionMode === "FIXED").map((r) => [r.id as string, r]),
  );
  if (composed.size === 0) return;
  if (inv.status !== "DRAFT") {
    throw new BadRequestException("Only DRAFT invoices can be edited");
  }
  for (const l of editLines) {
    const row = l.rowId ? composed.get(l.rowId) : undefined;
    if (!row || l.untouched || !inv.tenantId) continue;
    const scope = { invoiceItemId: row.id, tenantId: inv.tenantId };
    const newQty = Number(l.data.qty);
    const oldQty = Number(row.qty);
    const upb = Number(l.data.unitsPerBox ?? row.unitsPerBox ?? 0);
    const price = componentUnitPrice4(roundMoney(Number(l.data.subtotal)), newQty);
    if (newQty === oldQty) {
      if (Number(l.data.subtotal) !== Number(row.subtotal)) {
        await tx.invoiceItemComponent.updateMany({
          where: scope,
          data: { displayUnitPrice4: price },
        });
      }
      continue;
    }
    const whole = (q: number) => upb > 0 && Number.isInteger(q / upb) && q > 0;
    if (!whole(newQty) || !whole(oldQty) || Number(l.data.pieces ?? 0) !== 0) {
      throw refuse("A mixed-pack line can only change by whole boxes.");
    }
    const stored = await tx.invoiceItemComponent.findMany({
      where: scope,
      orderBy: { position: "asc" },
    });
    const sum = stored.reduce((a: number, c: { qty: number }) => a + c.qty, 0);
    if (stored.length === 0 || sum !== oldQty) {
      throw refuse("This line's components no longer match its quantity.");
    }
    const planned = rescaleComposition({
      stored: stored.map((c: any) => ({ componentProductId: c.componentProductId, qty: c.qty })),
      unitsPerPack: upb,
      boxes: newQty / upb,
    });
    await tx.invoiceItemComponent.deleteMany({ where: scope });
    await tx.invoiceItemComponent.createMany({
      data: planned.map((p, i) => ({
        tenantId: inv.tenantId,
        invoiceItemId: row.id,
        componentProductId: p.componentProductId,
        qty: p.qty,
        name: stored[i].name,
        unitSku: stored[i].unitSku,
        unitBarcode: stored[i].unitBarcode,
        barcodeSymbology: stored[i].barcodeSymbology,
        displayUnitPrice4: price,
        position: stored[i].position,
      })),
    });
  }
}
