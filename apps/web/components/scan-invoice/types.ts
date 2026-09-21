import type { ScannedItem, ScanResult, ScanCandidate } from "@/lib/api/invoice-scan";
import type { PieceSnapshot, BillLineDenomination } from "@/lib/scan-line-units";
import type { DuplicateVendorBillInfo, ScanArchive } from "@/lib/api/vendor-bills";

export type CreateMode = "bill" | "expense" | "both";

/**
 * The extraction plus its archive envelope. `scanInvoice()` is typed against
 * the document shape alone, so the archive fields are asserted on at the one
 * call site rather than being threaded through the transport type.
 */
export type ArchivedScanResult = ScanResult & ScanArchive;

export interface VarietySplit {
  productId: string;
  qty: string;
  /** Self-describing so split rows/bill-line descriptions never need a
   *  catalog lookup — carried over from the sibling fetch or the manual-add
   *  picker's onChange product object. */
  name?: string;
  variantName?: string | null;
}

export interface ReviewItem {
  extractedName: string;
  productId: string;
  description: string;
  /**
   * The scan match's own composed name, kept separate from `description`
   * (which the operator can freely retype for custom/unlinked lines) so the
   * async picker's closed-state label survives an edit to the description.
   */
  matchedProductName?: string | null;
  /** Scanned per-line SKU/item code, if the OCR found one — prefills the
   *  create-product form when the operator adds this line as a new product. */
  sku?: string | null;
  /** Units per box/case, if the OCR read one — prefills the create-product
   *  form's units-per-box field when the operator adds this line as a new product. */
  packSize?: number | null;
  /**
   * Set when the scan's match came from a remembered correction (the
   * `ProductAlias` or legacy `ProductMapping` tier) rather than fresh fuzzy
   * matching. Cleared on any manual product change — once the operator
   * picks, the badge should no longer claim it was "remembered".
   */
  matchSource?: ScannedItem["matchSource"] | null;
  /**
   * Canonical pieces-terms truth for this line: `{qtyPieces, costPerPiece}`.
   * Established once from the scan extraction (or the current on-screen
   * values for a manually-added row) and kept in sync with direct
   * qty/unitCost/packSize edits. The Boxes/Pieces toggle replays THIS
   * through `toBillLine` instead of re-deriving from whatever's currently
   * displayed, so switching back and forth never drifts a cent from the
   * original numbers — a Boxes line posted without an explicit `packSize`
   * is the #335/#336 stock/AVCO corruption class (see A3).
   */
  preConvert?: PieceSnapshot;
  /**
   * UI-only pieces-per-box draft. Lets the operator dial in — or a linked
   * product arm from its `unitsPerBox` — a case size WITHOUT silently
   * changing the line's actual unit; only applied to `packSize` once the
   * operator explicitly switches this line to Boxes.
   */
  ppbDraft?: number | null;
  /** The linked product's own units-per-box, if any — flags a mismatch
   *  against the on-screen case size (the on-screen value always wins). */
  catalogUnitsPerBox?: number | null;
  /** Last unit-conversion's warning, if the requested unit couldn't be honored. */
  unitWarning?: BillLineDenomination["warning"];
  /** Ranked "Did you mean…" suggestions for a line that didn't confidently match. */
  candidates?: ScanCandidate[];
  qty: string;
  unitCost: string;
  lineTotal: number | null; // raw AI-extracted line total (read-only reference)
  extractedQty: string; // original AI-extracted qty (for hint display)
  extractedUnitCost: string; // original AI-extracted unit cost (for hint display)
  confidence: ScannedItem["confidence"];
  /**
   * When set, the operator has split the row across product variants
   * (e.g. "Geek Next 50K — 20 ea" → 10 Strawberry + 4 Mango + 6 Butterscotch).
   * On submit, each entry with qty > 0 becomes its own VendorBillItem and
   * the row-level productId/qty are ignored.
   */
  splits?: VarietySplit[];
}

// "skipped" = the operator dropped a pre-existing (already-recorded) invoice
// from the batch. Status-based rather than array removal so object URLs stay
// valid for undo, the navigator index stays stable mid-submit, and every
// status-filtered consumer (targets/creatable/leftBehind/firstUnposted)
// excludes it without separate bookkeeping.
export type InvoiceStatus = "scanning" | "scanned" | "failed" | "created" | "skipped";

export interface PagePreview {
  url: string;
  type: "pdf" | "image";
  name: string;
}

/**
 * One invoice in the batch. A "group" is either a single PDF (each PDF the
 * operator drops is its own invoice → its own scan → its own vendor bill) or
 * ALL loose image files together (photographed pages of one invoice). The
 * whole review form state lives per invoice so the ◀ ▶ navigator can switch
 * both the preview and the form.
 */
export interface InvoiceGroup {
  id: string;
  kind: "pdf" | "images";
  files: File[]; // kept for per-invoice retry
  pagePreviews: PagePreview[];
  previewIndex: number;
  status: InvoiceStatus;
  error: string | null;
  scanResult: ArchivedScanResult | null;
  reviewItems: ReviewItem[];
  /** Supplier's own invoice number — extracted, editable, saved into bill notes. */
  invoiceNumber: string;
  supplierId: string;
  /** Auto-match found several candidate suppliers — operator must pick. */
  supplierMatchAmbiguous: boolean;
  billDate: string;
  dueDate: string;
  createMode: CreateMode;
  expenseCategoryId: string;
  expenseDescription: string;
  expenseDate: string;
  expensePaymentMethod: string;
  expenseNotes: string;
  /** Idempotency guards: a retried "Create" never re-posts what already succeeded. */
  createdBillId: string | null;
  expenseCreated: boolean;
  /** An existing bill this invoice matches — from the pre-flight probe or a create 409. */
  duplicate: DuplicateVendorBillInfo | null;
  duplicateCheckPending: boolean;
  /** Operator chose to record it anyway; also lifts the batch skip. */
  allowDuplicate: boolean;
}
