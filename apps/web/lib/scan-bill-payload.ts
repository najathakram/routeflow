import type { CreateVendorBillDto, CreateVendorBillItem } from "./api/vendor-bills";
import { raisePoBlocker } from "./raise-po";
import { roundMoney } from "@routeflow/pricing";

/** The subset of a scan invoice's state {@link buildVendorBillPayload} needs. */
export interface ScanBillPayloadInput {
  supplierId: string;
  billDate: string;
  dueDate: string;
  invoiceNumber: string;
  allowDuplicate: boolean;
  raisePo: boolean;
  scanId?: string | null;
  tax?: number | null;
  subtotal?: number | null;
}

/**
 * The vendor-bill create payload for one scanned invoice (units/PO step 7's scan flow, the
 * "Create" button in `ScanInvoiceModal`). Pulled out so `createPurchaseOrder`'s presence — drop
 * it and the bill auto-receives, stock moves, and no PO is raised, with every existing test
 * still green — is pinned by a direct unit test rather than only reachable by rendering the
 * whole modal.
 */
export function buildVendorBillPayload(
  inv: ScanBillPayloadInput,
  items: CreateVendorBillItem[],
): CreateVendorBillDto {
  const raisesPo = inv.raisePo && !raisePoBlocker(inv.supplierId, items);
  const tax = inv.tax ?? 0;
  const subtotal = inv.subtotal ?? 0;
  return {
    supplierId: inv.supplierId,
    billDate: inv.billDate,
    dueDate: inv.dueDate || "",
    items,
    // Persist the supplier's own invoice number — it's how the operator reconciles against the
    // supplier statement later.
    notes: inv.invoiceNumber ? `Supplier invoice #${inv.invoiceNumber}` : undefined,
    supplierInvoiceNumber: inv.invoiceNumber.trim() || undefined,
    allowDuplicate: inv.allowDuplicate || undefined,
    // The API turns the mapped lines into a draft PO linked to this bill; a switch left on
    // while a line went unmatched is ignored rather than refused.
    createPurchaseOrder: raisesPo ? true : undefined,
    // Sales tax is owed too; the server folds it into totalOwed (line items only carry the
    // pre-tax unit costs).
    taxAmount: tax > 0 ? roundMoney(tax) : undefined,
    // Pre-tax total as the invoice printed it — stored as evidence; the amount owed is still
    // summed from the lines.
    subtotal: subtotal > 0 ? roundMoney(subtotal) : undefined,
    // Closes the loop from bill back to the document it came from, and marks that scan POSTED
    // so the archive stops offering it as unfinished.
    scanId: inv.scanId ?? undefined,
  };
}
