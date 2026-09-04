import type {
  DuplicateVendorBillInfo,
  PriorScanSummary,
  ScanResult,
  ScannedItem,
} from "./api/vendor-bills";
import { roundMoney } from "@routeflow/pricing";
import { toBillLine, type PieceSnapshot, type ScanLineUnit } from "./scan-line-units";

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

/**
 * `matchSource` and the scan-level `supplierId` are server fields added by
 * the API work package of this same PR-5 batch; `operatorConfirmed` and
 * `warning` are client-only. `api/vendor-bills.ts`'s `ScanResult`/`ScannedItem`
 * types are owned by a different work package, so the additive shape is
 * declared locally rather than widening a file outside this package's scope
 * — both new fields are optional, so a plain `ScanResult`/`ScannedItem`
 * value is still structurally assignable wherever these are expected.
 */
export interface ScannedItemEx extends ScannedItem {
  /** Set server-side when this line resolved from ProductAlias/legacy ProductMapping memory. */
  matchSource?: "alias" | "memory" | null;
  /**
   * Client-only: true once the OPERATOR explicitly picked/confirmed this
   * link (candidate chip, picker, or create sheet) — never set for the AI's
   * own auto-match. Only confirmed links are safe to teach back via
   * `mappingsFromScan`, or the app would learn from its own guesses.
   */
  operatorConfirmed?: boolean;
  /** Set by `applyLineEdit` when the last Boxes/Pieces conversion needed a caveat. */
  warning?: "NOT_DIVISIBLE" | "PPB_MISMATCH";
}

export interface ScanResultEx extends Omit<ScanResult, "items"> {
  /** Server-resolved supplier id (`supplier-match.ts`) — preferred over a
   *  client-side name lookup against the loaded `suppliers` list. */
  supplierId?: string | null;
  items: ScannedItemEx[];
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
 * it to the line sum, so `scanBillTotal` counts it too.
 *
 * Supplier: the server now resolves `supplierId` itself (`supplier-match.ts`,
 * same exact→startsWith→contains ladder import uses) — prefer that over the
 * client-side exact-name lookup here, which stays only as a fallback for a
 * cached/older scan payload that never carried one. */
export function buildBillDtoFromScan(
  result: ScanResultEx,
  suppliers: SupplierRef[] | undefined,
): ScanBillDto {
  const supplierName = (result.supplier ?? "").trim();
  const matchedSupplier = supplierName
    ? suppliers?.find((s) => s.name.toLowerCase() === supplierName.toLowerCase())
    : undefined;
  const supplierId = result.supplierId ?? matchedSupplier?.id ?? undefined;
  const invoiceNumber = (result.invoiceNumber ?? "").trim();
  const tax = roundMoney(result.tax ?? 0);
  const subtotal = roundMoney(result.subtotal ?? 0);

  return {
    supplierId,
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
 * Link one extracted line to a product (from picking an existing product,
 * tapping a candidate chip, OR creating one on the spot) — every path goes
 * through this one function. Returns a new ScanResult — the line's confidence
 * is promoted to "high" and `operatorConfirmed` is set, since the operator
 * explicitly chose it (as opposed to the AI's own auto-match). Only
 * confirmed links are safe to teach back — see `mappingsFromScan`.
 */
export function linkScanItem(
  result: ScanResultEx,
  index: number,
  productId: string,
  productName: string,
): ScanResultEx {
  return {
    ...result,
    items: result.items.map((it, i) =>
      i === index
        ? {
            ...it,
            matchedProductId: productId,
            matchedProductName: productName,
            confidence: "high",
            operatorConfirmed: true,
          }
        : it,
    ),
  };
}

/**
 * Mappings to persist so the AI matcher learns — one per line the OPERATOR
 * explicitly confirmed (`operatorConfirmed`, set by `linkScanItem`). A line
 * the AI auto-matched on its own (arrives pre-matched from the scan, never
 * touched by `linkScanItem`) is excluded: teaching the matcher from its own
 * unconfirmed guesses is exactly the self-reinforcing bug this filters out.
 * Requires a supplier name (the mapping key on the server).
 */
export function mappingsFromScan(result: ScanResultEx): ScanProductMapping[] {
  const supplierName = (result.supplier ?? "").trim();
  if (!supplierName) return [];
  return (result.items ?? [])
    .filter((i) => i.operatorConfirmed === true && !!i.matchedProductId && !!i.extractedName)
    .map((i) => ({
      supplierName,
      rawDescription: i.extractedName,
      productId: i.matchedProductId as string,
    }));
}

// ─── Boxes/Pieces line editing (A3) ────────────────────────────────────────────
// `LineEditSheet` lets the operator re-denominate one scanned line between
// Boxes and Pieces. All the actual unit math is `scan-line-units.ts#toBillLine`
// (the binding A3 contract) — everything here just seeds/commits it so the
// toggle is lossless and `packSize` never survives stale next to a Pieces
// choice (the #335/#336 stock/AVCO corruption class).

/**
 * The canonical, unit-independent `PieceSnapshot` a scanned line's CURRENT
 * qty/unitCost/packSize represents — seeds `LineEditSheet`'s toggle baseline
 * exactly once per line. Toggling Boxes<->Pieces from this fixed snapshot
 * (rather than re-deriving from whatever's currently on screen) is what makes
 * repeated flips restore the original values exactly instead of drifting
 * through already-rounded intermediate numbers.
 *
 * The derived per-piece cost is deliberately NOT rounded here (same as web's
 * `canonicalizeLine`): the snapshot is the full-precision canonical form and
 * `toBillLine` applies `roundUnitCost` once, on the value it emits. Rounding
 * the quotient too would make a case cost that doesn't divide evenly come
 * back changed — $19.99/24 would redisplay and save as $19.9896.
 */
export function pieceSnapshotFromLine(line: {
  qty: number;
  unitCost: number;
  packSize?: number | null;
}): PieceSnapshot {
  const ppb = line.packSize;
  if (ppb != null && ppb > 1) {
    return { qtyPieces: line.qty * ppb, costPerPiece: line.unitCost / ppb };
  }
  return { qtyPieces: line.qty, costPerPiece: line.unitCost };
}

/** The unit a scanned line is CURRENTLY denominated in — derived from
 *  `packSize`, never stored separately (A3: "unit DERIVED from packSize>1"). */
export function unitFromLine(line: { packSize?: number | null }): ScanLineUnit {
  return line.packSize != null && line.packSize > 1 ? "boxes" : "pieces";
}

/**
 * Pieces-per-box prefill for the sheet: the OCR-read `packSize` first, else
 * the linked product's `unitsPerBox` — "OCR-then-product", per the plan.
 * Never invented from neither, and never 1 (that isn't boxed at all).
 */
export function initialPpbDraft(
  line: { packSize?: number | null },
  catalogUnitsPerBox?: number | null,
): number | null {
  if (line.packSize != null && line.packSize > 1) return line.packSize;
  if (catalogUnitsPerBox != null && catalogUnitsPerBox > 1) return catalogUnitsPerBox;
  return null;
}

/**
 * Pure Boxes/Pieces commit for one scan line: delegate the actual conversion
 * to `toBillLine` and write its FULL result — `qty`, `unitCost`, and
 * `packSize` explicitly (including `null`) — into the line, replacing
 * whatever it had before. `packSize` is never left at a stale OCR value: a
 * Pieces choice always clears it to `null`, so the receive-time
 * `lineInventoryDelta` conversion (which fires whenever `packSize > 1`) can
 * never accidentally fire for a line the operator chose to bill in pieces.
 * Any previous warning is cleared the same way when the new conversion is clean.
 */
export function applyLineEdit(
  result: ScanResultEx,
  index: number,
  snap: PieceSnapshot,
  unit: ScanLineUnit,
  piecesPerBox: number | null | undefined,
  catalogUnitsPerBox?: number | null,
): ScanResultEx {
  const denom = toBillLine(snap, unit, piecesPerBox, catalogUnitsPerBox);
  return {
    ...result,
    items: result.items.map((it, i) =>
      i === index
        ? {
            ...it,
            qty: denom.qty,
            unitCost: denom.unitCost,
            packSize: denom.packSize,
            warning: denom.warning,
          }
        : it,
    ),
  };
}
