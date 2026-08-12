import type { DuplicateVendorBillInfo, PriorScanSummary, ScanResult } from "./api/vendor-bills";
import { roundMoney } from "./pricing";

/**
 * Pure (screen-free, testable) helpers for the vendor-bill scan flow — turn an AI
 * ScanResult into the create-bill DTO and the learned product mappings. Kept out of
 * the RN screens so `apps/mobile/__tests__/*.test.ts` (pure-logic, node env) can
 * lock the API-field mapping (extractedName→description, matchedProductId→productId,
 * invoiceDate→billDate) that the screen previously got wrong.
 */

export interface SupplierRef {
  id: string;
  name: string;
}

export interface ScanBillItemDto {
  description: string;
  productId?: string;
  qty: number;
  unitCost: number;
  /** Supplier's item code as printed — matches this line to a product next scan. */
  sku?: string;
  /** Units per box/case, only when the line explicitly printed one. */
  packSize?: number;
  /** Line amount as printed, not derived from qty × unitCost. */
  lineTotal?: number;
}

export interface ScanBillDto {
  supplierId?: string;
  billDate?: string;
  notes?: string;
  /** The supplier's own invoice number — the server's duplicate key. */
  supplierInvoiceNumber?: string;
  /** Sales tax as printed — the server folds it into totalOwed. */
  taxAmount?: number;
  /** Pre-tax total as printed. Stored only; totalOwed still comes from the lines. */
  subtotal?: number;
  /** The archived scan this bill was keyed from. */
  scanId?: string;
  items: ScanBillItemDto[];
}

export interface ScanProductMapping {
  supplierName: string;
  rawDescription: string;
  productId: string;
}

/** Build the POST /vendor-bills DTO from a scan result. Lines with neither a
 * quantity nor a cost are dropped (blank AI rows); everything else is kept even
 * when unmatched (`productId` omitted) so the bill can be linked later.
 *
 * Per-line `sku`/`packSize`/`lineTotal` and the document's `subtotal`/`tax` are
 * carried through as printed — they were read off the invoice and used to be
 * dropped on the floor here. Tax is the one that moves money: the server adds
 * it to the line sum, so `scanBillTotal` counts it too. */
export function buildBillDtoFromScan(
  result: ScanResult,
  suppliers: SupplierRef[] | undefined,
): ScanBillDto {
  const supplierName = (result.supplier ?? "").trim();
  const matchedSupplier = supplierName
    ? suppliers?.find((s) => s.name.toLowerCase() === supplierName.toLowerCase())
    : undefined;
  const invoiceNumber = (result.invoiceNumber ?? "").trim();
  const tax = roundMoney(result.tax ?? 0);
  const subtotal = roundMoney(result.subtotal ?? 0);

  return {
    supplierId: matchedSupplier?.id,
    billDate: result.invoiceDate ?? undefined,
    notes: scanNotes(supplierName, invoiceNumber),
    supplierInvoiceNumber: invoiceNumber || undefined,
    taxAmount: tax > 0 ? tax : undefined,
    subtotal: subtotal > 0 ? subtotal : undefined,
    scanId: result.scanId ?? undefined,
    items: (result.items ?? [])
      .filter((i) => (i.qty ?? 0) > 0 || (i.unitCost ?? 0) > 0)
      .map((i) => ({
        description: i.extractedName,
        productId: i.matchedProductId ?? undefined,
        qty: i.qty ?? 1,
        unitCost: i.unitCost ?? 0,
        sku: i.sku?.trim() || undefined,
        packSize: i.packSize ?? undefined,
        lineTotal: i.lineTotal ?? undefined,
      })),
  };
}

/** The "Supplier invoice #N" fragment is load-bearing: it is the only carrier
 * the server's legacy notes parser reads, so the number must stay a single
 * unbroken token at the end of the phrase. */
function scanNotes(supplierName: string, invoiceNumber: string): string | undefined {
  const parts: string[] = [];
  if (supplierName) parts.push(`AI scanned from ${supplierName}`);
  if (invoiceNumber) parts.push(`Supplier invoice #${invoiceNumber}`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** What the server will compute as `totalOwed` for this DTO — the duplicate
 * probe only lines up with the create-time guard when both see the same total.
 * Line costs are pre-tax, so the printed tax has to be added on top exactly as
 * `create()` does. */
export function scanBillTotal(dto: ScanBillDto): number {
  return roundMoney(
    dto.items.reduce((sum, i) => sum + i.qty * i.unitCost, 0) + (dto.taxAmount ?? 0),
  );
}

/** Alert copy for a scan that matches an already-recorded bill. A resumable
 * (DRAFT) match is a nudge; anything else warns about double-counting. */
export function duplicateBillPrompt(duplicate: DuplicateVendorBillInfo): {
  message: string;
  destructive: boolean;
} {
  const bill = duplicate.supplierName
    ? `${duplicate.supplierName} bill ${duplicate.billNumber}`
    : `Bill ${duplicate.billNumber}`;
  const amount = `$${roundMoney(duplicate.totalOwed).toFixed(2)}`;
  return duplicate.resumable
    ? {
        message: `${bill} (${amount}) is already saved as a draft — open it to finish.`,
        destructive: false,
      }
    : {
        message: `${bill} (${amount}) already records this invoice — creating it again would double stock and amounts owed.`,
        destructive: true,
      };
}

/** Alert copy for a photo whose exact bytes were read before. Never a failure:
 * either a bill already exists (open it rather than paying twice in stock and
 * cash), or an abandoned review just came back whole off the archive, with no
 * second AI call. `billId` is set only when there is something to open. */
export function priorScanPrompt(prior: PriorScanSummary): {
  title: string;
  message: string;
  billId: string | null;
  billLabel: string;
} {
  const when = scanDate(prior.scannedAt);
  const bill = prior.billNumber ?? "an existing bill";
  if (prior.status === "POSTED" && prior.vendorBillId) {
    const amount = prior.total != null ? ` (${`$${roundMoney(prior.total).toFixed(2)}`})` : "";
    return {
      title: "You already scanned this",
      message: `This invoice was scanned${when ? ` on ${when}` : ""} and recorded as ${bill}${amount}. Creating it again would double stock and amounts owed.`,
      billId: prior.vendorBillId,
      billLabel: `Open ${bill}`,
    };
  }
  return {
    title: "Picking up where you left off",
    message: `You scanned this invoice${when ? ` on ${when}` : " before"} and never finished. Your extraction is restored below — the invoice wasn't re-read.`,
    billId: null,
    billLabel: "",
  };
}

/** "Jul 3, 2026" for a stored ISO timestamp; empty when it can't be read. */
function scanDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * How many extracted lines still have NO product link (and carry a real qty or
 * cost). These are the lines that would silently fail to restock at receive —
 * the review UI surfaces this count so the operator can link/create each one.
 */
export function unmatchedCount(result: ScanResult): number {
  return (result.items ?? []).filter(
    (i) => !i.matchedProductId && ((i.qty ?? 0) > 0 || (i.unitCost ?? 0) > 0),
  ).length;
}

/**
 * Link one extracted line to a product (from picking an existing product OR
 * creating one on the spot). Returns a new ScanResult — the line's confidence is
 * promoted to "high" since the operator explicitly chose it.
 */
export function linkScanItem(
  result: ScanResult,
  index: number,
  productId: string,
  productName: string,
): ScanResult {
  return {
    ...result,
    items: result.items.map((it, i) =>
      i === index
        ? {
            ...it,
            matchedProductId: productId,
            matchedProductName: productName,
            confidence: "high",
          }
        : it,
    ),
  };
}

/** Mappings to persist so the AI matcher learns — one per line that ended up
 * linked to a product. Requires a supplier name (the mapping key on the server). */
export function mappingsFromScan(result: ScanResult): ScanProductMapping[] {
  const supplierName = (result.supplier ?? "").trim();
  if (!supplierName) return [];
  return (result.items ?? [])
    .filter((i) => !!i.matchedProductId && !!i.extractedName)
    .map((i) => ({
      supplierName,
      rawDescription: i.extractedName,
      productId: i.matchedProductId as string,
    }));
}
