"use client";

import React from "react";
import {
  X,
  Upload,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  Trash2,
  FileText,
  ShoppingCart,
  Receipt,
  Layers,
  Plus,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  ExternalLink,
  Undo2,
} from "lucide-react";
import { Button, useToast, cn } from "@routeflow/ui/web";
import {
  scanInvoice,
  type ScannedItem,
  type ScanResult,
  type ScanCandidate,
} from "@/lib/api/invoice-scan";
import {
  toBillLine,
  type ScanLineUnit,
  type PieceSnapshot,
  type BillLineDenomination,
} from "@/lib/scan-line-units";
import { useSuppliers } from "@/lib/api/inventory";
import {
  useCheckVendorBillDuplicate,
  useCreateVendorBill,
  useReceiveVendorBill,
  useSaveProductMapping,
  getDuplicateVendorBillError,
  type CreateVendorBillItem,
  type DuplicateVendorBillInfo,
  type PriorScanSummary,
  type ScanArchive,
} from "@/lib/api/vendor-bills";
import { useCreateExpense, useExpenseCategories } from "@/lib/api/finance";
import { SupplierSelect } from "./SupplierSelect";
import { SearchableProductPicker } from "./SearchableProductPicker";
import { ProductCreateModal } from "./ProductCreateModal";
import { displayProductName } from "@/lib/product-display";
import { fmtCalendarDate, fmtDate } from "@/lib/formatting";
import { roundMoney } from "@routeflow/pricing";
import { apiClient } from "@/lib/api-client";
import { SELECTABLE_PAYMENT_METHODS, PAYMENT_METHOD_LABELS } from "@/lib/payment-methods";

const fmt = (n: number | null | undefined) =>
  n != null
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n)
    : "—";

type CreateMode = "bill" | "expense" | "both";

/**
 * The extraction plus its archive envelope. `scanInvoice()` is typed against
 * the document shape alone, so the archive fields are asserted on at the one
 * call site rather than being threaded through the transport type.
 */
type ArchivedScanResult = ScanResult & ScanArchive;

interface VarietySplit {
  productId: string;
  qty: string;
  /** Self-describing so split rows/bill-line descriptions never need a
   *  catalog lookup — carried over from the sibling fetch or the manual-add
   *  picker's onChange product object. */
  name?: string;
  variantName?: string | null;
}

interface ReviewItem {
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
type InvoiceStatus = "scanning" | "scanned" | "failed" | "created" | "skipped";

interface PagePreview {
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
interface InvoiceGroup {
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

const emptyReviewItem = (): ReviewItem => ({
  extractedName: "",
  productId: "",
  description: "",
  qty: "1",
  unitCost: "",
  lineTotal: null,
  extractedQty: "1",
  extractedUnitCost: "",
  confidence: "none",
});

const makeInvoice = (kind: "pdf" | "images", files: File[]): InvoiceGroup => ({
  id: crypto.randomUUID(),
  kind,
  files,
  pagePreviews: files.map((f) => ({
    url: URL.createObjectURL(f),
    type: f.type === "application/pdf" ? ("pdf" as const) : ("image" as const),
    name: f.name,
  })),
  previewIndex: 0,
  status: "scanning",
  error: null,
  scanResult: null,
  reviewItems: [],
  invoiceNumber: "",
  supplierId: "",
  supplierMatchAmbiguous: false,
  billDate: new Date().toISOString().slice(0, 10),
  dueDate: "",
  createMode: "bill",
  expenseCategoryId: "",
  expenseDescription: "",
  expenseDate: new Date().toISOString().slice(0, 10),
  expensePaymentMethod: "CASH",
  expenseNotes: "",
  createdBillId: null,
  expenseCreated: false,
  duplicate: null,
  duplicateCheckPending: false,
  allowDuplicate: false,
});

/**
 * Grouping rule (owner decision): each PDF is its own invoice; all image
 * files together are the pages of ONE invoice. A single file of either kind
 * behaves exactly like today's flow.
 */
function groupFiles(files: File[]): Array<{ kind: "pdf" | "images"; files: File[] }> {
  const groups: Array<{ kind: "pdf" | "images"; files: File[] }> = [];
  const images: File[] = [];
  let imagesAt = -1;
  files.forEach((f) => {
    if (f.type === "application/pdf") {
      groups.push({ kind: "pdf", files: [f] });
    } else {
      if (imagesAt === -1) imagesAt = groups.length;
      images.push(f);
    }
  });
  if (images.length > 0) groups.splice(imagesAt, 0, { kind: "images", files: images });
  return groups;
}

/**
 * Scored supplier auto-match (replaces first-substring-wins): exact name →
 * unique startsWith → unique substring (either direction, longest name wins).
 * Several equally-plausible candidates → no silent pick, operator chooses.
 */
function matchSupplier(
  detected: string,
  suppliers: Array<{ id: string; name: string }>,
): { id: string; ambiguous: boolean } {
  const d = detected.trim().toLowerCase();
  if (!d) return { id: "", ambiguous: false };
  const exact = suppliers.filter((s) => s.name.trim().toLowerCase() === d);
  if (exact.length === 1) return { id: exact[0].id, ambiguous: false };
  if (exact.length > 1) return { id: "", ambiguous: true };
  const starts = suppliers.filter(
    (s) => s.name.trim().toLowerCase().startsWith(d) || d.startsWith(s.name.trim().toLowerCase()),
  );
  if (starts.length === 1) return { id: starts[0].id, ambiguous: false };
  if (starts.length > 1) return { id: "", ambiguous: true };
  const contains = suppliers.filter((s) => {
    const n = s.name.trim().toLowerCase();
    return n.includes(d) || d.includes(n);
  });
  if (contains.length === 1) return { id: contains[0].id, ambiguous: false };
  return { id: "", ambiguous: contains.length > 1 };
}

/**
 * A row's pieces-terms canonical truth, derived from its current on-screen
 * qty/unitCost/packSize (unit is DERIVED from `packSize > 1`, never stored
 * separately). Recomputed after every DIRECT qty/unitCost/packSize edit so
 * the Boxes/Pieces toggle always replays what's actually on screen — never a
 * stale OCR extraction. The toggle itself must NOT call this: it replays the
 * row's existing `preConvert` snapshot instead, so repeated toggling never
 * drifts (see `toBillLine` in lib/scan-line-units.ts).
 */
function canonicalizeLine(qty: string, unitCost: string, packSize: number | null): PieceSnapshot {
  const q = parseFloat(qty) || 0;
  const c = parseFloat(unitCost) || 0;
  const pack = packSize && packSize > 1 ? packSize : null;
  return pack ? { qtyPieces: q * pack, costPerPiece: c / pack } : { qtyPieces: q, costPerPiece: c };
}

const MAX_FILE_BYTES = 25 * 1024 * 1024; // server-side Multer per-file cap
const MAX_PAGES_PER_INVOICE = 10; // server-side FilesInterceptor cap per scan call
const MAX_INVOICES_PER_BATCH = 10; // bounds Claude spend per batch

function ConfidenceBadge({
  confidence,
  matchSource,
}: {
  confidence: ScannedItem["confidence"];
  /** Present when the match came from a taught correction — outranks the
   *  fuzzy-confidence label below, since it isn't a guess. */
  matchSource?: ScannedItem["matchSource"] | null;
}) {
  if (matchSource === "alias" || matchSource === "memory") {
    return (
      <span
        className="inline-flex items-center whitespace-nowrap rounded-full bg-brand-100 px-2 py-0.5 text-xs font-medium text-brand-700"
        title="Remembered from a previous correction on this supplier. Clearing this match makes the scanner forget it — the next scan will guess again."
      >
        Remembered match
      </span>
    );
  }
  const styles: Record<ScannedItem["confidence"], string> = {
    high: "bg-green-100 text-green-700",
    medium: "bg-yellow-100 text-yellow-700",
    low: "bg-orange-100 text-orange-700",
    none: "bg-gray-100 text-gray-600",
  };
  // "low" no longer means "matched, but shakily" — the matcher never
  // auto-assigns below 0.6, so a "low" line arrives UNLINKED with ranked
  // "Did you mean…" chips below it instead. Label + tooltip say so.
  const labels: Record<ScannedItem["confidence"], string> = {
    high: "High match",
    medium: "Possible match",
    low: "Unmatched",
    none: "No match",
  };
  const titles: Partial<Record<ScannedItem["confidence"], string>> = {
    low: "No confident match — review the suggestions below",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
        styles[confidence],
      )}
      title={titles[confidence]}
    >
      {labels[confidence]}
    </span>
  );
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated?: () => void;
}

export function ScanInvoiceModal({ open, onClose, onCreated }: Props) {
  const { toast } = useToast();
  const [step, setStep] = React.useState<"upload" | "processing" | "review">("upload");
  // Row index a "Create product from this line" quick-create is open for.
  const [createFromRow, setCreateFromRow] = React.useState<number | null>(null);
  const [isDragging, setIsDragging] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [showPreview, setShowPreview] = React.useState(true);
  // Disables the Create button across the WHOLE multi-invoice create loop —
  // the per-mutation isPending flickers between invoices, which would let a
  // fast double-click race the idempotency state writes.
  const [isSubmittingAll, setIsSubmittingAll] = React.useState(false);

  // ── Per-invoice state ───────────────────────────────────────────────────
  // Single source of truth: the invoices array. The flat names the review JSX
  // has always used (supplierId, reviewItems, pagePreviews, …) are DERIVED
  // from invoices[activeIndex]; their setters are thin wrappers that write to
  // the active entry. Wrappers stay plain closures (NO useCallback) so they
  // can never capture a stale activeIndex.
  const [invoices, setInvoicesRaw] = React.useState<InvoiceGroup[]>([]);
  const [activeIndex, setActiveIndex] = React.useState(0);
  // Bumped on reset / re-upload / scan-again; async scan callbacks compare it
  // so a stale response can never clobber a fresh session's state.
  const runIdRef = React.useRef(0);
  // In-flight scan requests, aborted on reset so cancelled batches stop
  // burning Claude tokens (not just stop writing state).
  const abortersRef = React.useRef(new Map<string, AbortController>());
  // Synchronous mirror of `invoices` — read by the async create loop and the
  // unmount cleanup, updated inside the setter so it can't lag a render.
  const invoicesRef = React.useRef<InvoiceGroup[]>([]);
  const setInvoices = (
    updater: InvoiceGroup[] | ((prev: InvoiceGroup[]) => InvoiceGroup[]),
  ): void =>
    setInvoicesRaw((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      invoicesRef.current = next;
      return next;
    });
  const patchInvoiceById = (id: string, patch: Partial<InvoiceGroup>) =>
    setInvoices((prev) => prev.map((inv) => (inv.id === id ? { ...inv, ...patch } : inv)));

  const active: InvoiceGroup | undefined = invoices[activeIndex];
  const updateActive = (patch: Partial<InvoiceGroup>) =>
    setInvoices((prev) => prev.map((inv, i) => (i === activeIndex ? { ...inv, ...patch } : inv)));

  // Derived flat values + wrapper setters (same names/signatures the JSX uses)
  const scanResult = active?.scanResult ?? null;
  const reviewItems = active?.reviewItems ?? [];
  const createMode = active?.createMode ?? "bill";
  const setCreateMode = (v: CreateMode) => updateActive({ createMode: v });
  const setReviewItems = (u: ReviewItem[] | ((prev: ReviewItem[]) => ReviewItem[])) =>
    setInvoices((prev) =>
      prev.map((inv, i) =>
        i === activeIndex
          ? { ...inv, reviewItems: typeof u === "function" ? u(inv.reviewItems) : u }
          : inv,
      ),
    );
  const pagePreviews = active?.pagePreviews ?? [];
  const previewIndex = active?.previewIndex ?? 0;
  const setPreviewIndex = (u: number | ((n: number) => number)) =>
    setInvoices((prev) =>
      prev.map((inv, i) =>
        i === activeIndex
          ? { ...inv, previewIndex: typeof u === "function" ? u(inv.previewIndex) : u }
          : inv,
      ),
    );
  // Convenience accessors used throughout the JSX below
  const previewUrl = pagePreviews[previewIndex]?.url ?? null;
  const previewType = pagePreviews[previewIndex]?.type ?? null;

  // Bill fields
  const supplierId = active?.supplierId ?? "";
  // Both identity fields feed the duplicate probe, so editing either re-checks
  // and drops any override the operator had granted for the previous identity.
  const setSupplierId = (v: string) => {
    updateActive({
      supplierId: v,
      supplierMatchAmbiguous: false,
      allowDuplicate: false,
      // A new identity may no longer be the duplicate the operator dropped.
      ...(active?.status === "skipped" ? { status: "scanned" as const } : {}),
    });
    if (active) scheduleDuplicateCheck(active.id);
  };
  const billDate = active?.billDate ?? new Date().toISOString().slice(0, 10);
  const setBillDate = (v: string) => updateActive({ billDate: v });
  const dueDate = active?.dueDate ?? "";
  const setDueDate = (v: string) => updateActive({ dueDate: v });
  const invoiceNumber = active?.invoiceNumber ?? "";
  const setInvoiceNumber = (v: string) => {
    updateActive({
      invoiceNumber: v,
      allowDuplicate: false,
      ...(active?.status === "skipped" ? { status: "scanned" as const } : {}),
    });
    if (active) scheduleDuplicateCheck(active.id);
  };

  // Expense fields
  const expenseCategoryId = active?.expenseCategoryId ?? "";
  const setExpenseCategoryId = (v: string) => updateActive({ expenseCategoryId: v });
  const expenseDescription = active?.expenseDescription ?? "";
  const setExpenseDescription = (v: string) => updateActive({ expenseDescription: v });
  const expenseDate = active?.expenseDate ?? new Date().toISOString().slice(0, 10);
  const setExpenseDate = (v: string) => updateActive({ expenseDate: v });
  const expensePaymentMethod = active?.expensePaymentMethod ?? "CASH";
  const setExpensePaymentMethod = (v: string) => updateActive({ expensePaymentMethod: v });
  const expenseNotes = active?.expenseNotes ?? "";
  const setExpenseNotes = (v: string) => updateActive({ expenseNotes: v });

  const { data: suppliersData } = useSuppliers();
  const suppliers = (suppliersData as { id: string; name: string }[] | undefined) ?? [];

  type SiblingProduct = {
    id: string;
    name: string;
    variantName?: string | null;
    parentProductId?: string | null;
  };
  // Cache of already-fetched sibling families, keyed by the matched row's
  // productId — avoids re-fetching when the operator re-opens the split
  // panel or navigates between rows/invoices sharing the same product.
  const [siblingCache, setSiblingCache] = React.useState<Record<string, SiblingProduct[]>>({});
  const [siblingLoadingId, setSiblingLoadingId] = React.useState<string | null>(null);

  /**
   * On-demand replacement for the old preload-based getVariantSiblings. Same
   * two discovery paths, same ordering, but fetched only when the operator
   * reaches for the split feature — and no longer blind past the first 1000
   * products (the old preload silently no-op'd the split button there).
   */
  const fetchVariantSiblings = React.useCallback(
    async (matched: { id: string; name: string }): Promise<SiblingProduct[]> => {
      // Path 1 — parent-tagged family via the product detail (includes parent + variants).
      const detail = await apiClient.get(`/products/${matched.id}`).then((r) => r.data);
      const familyRootId: string = detail.parentProductId ?? detail.id;
      const root =
        familyRootId === detail.id
          ? detail
          : await apiClient.get(`/products/${familyRootId}`).then((r) => r.data);
      // Mirror the old semantics: the family set is the root's CHILDREN (variants);
      // the matched product itself is re-added first in the merge below.
      const parentSiblings: SiblingProduct[] = (root?.variants ?? []).map((v: any) => ({
        id: v.id,
        name: v.name,
        variantName: v.variantName ?? null,
        parentProductId: v.parentProductId ?? null,
      }));
      // Path 2 — name-prefix grouping for flavors entered as standalone products.
      const SEPARATORS = [" - ", " — ", ": "];
      const sep = SEPARATORS.find((s) => matched.name.includes(s));
      let prefixSiblings: SiblingProduct[] = [];
      if (sep) {
        const prefix = matched.name.split(sep).slice(0, -1).join(sep).trim();
        if (prefix.length >= 3) {
          const needle = `${prefix}${sep}`.toLowerCase();
          const res = await apiClient
            .get(`/products`, { params: { search: prefix, limit: 100 } })
            .then((r) => r.data);
          prefixSiblings = ((res?.data ?? []) as any[])
            .filter((p) => p.name.toLowerCase().startsWith(needle))
            .map((p) => ({
              id: p.id,
              name: p.name,
              variantName: p.variantName ?? null,
              parentProductId: p.parentProductId ?? null,
            }));
        }
      }
      const matchedSibling: SiblingProduct = {
        id: detail.id,
        name: detail.name,
        variantName: detail.variantName ?? null,
        parentProductId: detail.parentProductId ?? null,
      };
      const seen = new Set<string>();
      const merged: SiblingProduct[] = [];
      for (const p of [matchedSibling, ...parentSiblings, ...prefixSiblings]) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        merged.push(p);
      }
      return merged.sort((a, b) => {
        if (a.id === matched.id) return -1;
        if (b.id === matched.id) return 1;
        return (a.variantName ?? a.name).localeCompare(b.variantName ?? b.name);
      });
    },
    [],
  );

  const { data: expenseCategories } = useExpenseCategories();
  const categories = expenseCategories ?? [];

  const createBill = useCreateVendorBill();
  const receiveBill = useReceiveVendorBill();
  const createExpense = useCreateExpense();
  const saveMapping = useSaveProductMapping();
  const checkDuplicate = useCheckVendorBillDuplicate();

  // Pending debounced re-checks, keyed by invoice id.
  const dupTimersRef = React.useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const clearDuplicateTimers = () => {
    dupTimersRef.current.forEach((t) => clearTimeout(t));
    dupTimersRef.current.clear();
  };

  // Abort in-flight scans, revoke every live object URL, drop all invoices.
  const discardSession = () => {
    runIdRef.current++;
    abortersRef.current.forEach((c) => c.abort());
    abortersRef.current.clear();
    clearDuplicateTimers();
    invoicesRef.current.forEach((inv) =>
      inv.pagePreviews.forEach((p) => URL.revokeObjectURL(p.url)),
    );
    setInvoices([]);
    setActiveIndex(0);
    setCreateFromRow(null);
    setIsSubmittingAll(false);
  };

  // Reset when opened
  React.useEffect(() => {
    if (open) {
      discardSession();
      setStep("upload");
      setShowPreview(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The modal is permanently mounted at its entry points (only gated by
  // `open`), but if a parent ever unmounts it, in-flight scans and object
  // URLs must not leak.
  React.useEffect(() => {
    const timers = dupTimersRef.current;
    return () => {
      abortersRef.current.forEach((c) => c.abort());
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
      invoicesRef.current.forEach((inv) =>
        inv.pagePreviews.forEach((p) => URL.revokeObjectURL(p.url)),
      );
    };
  }, []);

  /** Seed an invoice's review state from its scan result. */
  const applyScan = (id: string, result: ArchivedScanResult) => {
    const items: ReviewItem[] = (result.items ?? []).map((item) => {
      const qty = item.qty ?? 1;
      const unitCost = item.unitCost ?? 0;
      // unit is DERIVED from packSize > 1 — normalize a stray packSize of 1
      // (or less) to null so it never falsely reads as a boxed line.
      const packSize = item.packSize && item.packSize > 1 ? item.packSize : null;
      return {
        extractedName: item.extractedName,
        productId: item.matchedProductId ?? "",
        description: item.matchedProductName ?? item.extractedName,
        matchedProductName: item.matchedProductName ?? null,
        matchSource: item.matchSource ?? null,
        sku: item.sku ?? null,
        packSize,
        // Arms the Boxes toggle with whatever case size the OCR read, so a
        // scanned case line can round-trip Pieces → Boxes without the
        // operator having to retype it.
        ppbDraft: packSize,
        // Canonicalize ONCE at scan-parse time — the toggle replays this
        // snapshot forever after, never re-deriving it from the display.
        preConvert: canonicalizeLine(String(qty), String(unitCost), packSize),
        candidates: item.candidates,
        qty: String(qty),
        unitCost: String(unitCost),
        lineTotal: item.lineTotal ?? null,
        extractedQty: String(qty),
        extractedUnitCost: String(unitCost),
        confidence: item.confidence,
      };
    });
    const patch: Partial<InvoiceGroup> = {
      status: "scanned",
      error: null,
      scanResult: result,
      reviewItems: items.length > 0 ? items : [emptyReviewItem()],
      invoiceNumber: result.invoiceNumber ?? "",
    };
    // The server resolves the supplier tenant-scoped (supplier-match.ts) —
    // prefer it over re-matching the free-text `supplier` name on the client.
    if (result.supplierId) {
      patch.supplierId = result.supplierId;
      patch.supplierMatchAmbiguous = false;
    } else if (result.supplier) {
      const match = matchSupplier(result.supplier, suppliers);
      patch.supplierId = match.id;
      patch.supplierMatchAmbiguous = match.ambiguous;
    }
    if (result.invoiceDate) {
      patch.billDate = result.invoiceDate;
      patch.expenseDate = result.invoiceDate;
    }
    if (result.expenseDescription) patch.expenseDescription = result.expenseDescription;
    if (result.expenseCategory) {
      const catMatch = categories.find(
        (c) =>
          c.name.toLowerCase().includes(result.expenseCategory!.toLowerCase()) ||
          result.expenseCategory!.toLowerCase().includes(c.name.toLowerCase()),
      );
      if (catMatch) patch.expenseCategoryId = catMatch.id;
    }
    patch.duplicate = null;
    patch.allowDuplicate = false;
    patchInvoiceById(id, patch);
    // Merge locally rather than re-reading invoicesRef: React may not have
    // flushed the patch yet, and the probe needs the just-scanned identity.
    const base = invoicesRef.current.find((x) => x.id === id);
    if (base) void runDuplicateCheck(id, { ...base, ...patch }, runIdRef.current);
  };

  /**
   * Scan one invoice group. `singleFlow` keeps today's exact single-invoice
   * UX: full-screen processing spinner, toast + back-to-upload on failure.
   * In batch mode a failure only marks that invoice failed (retryable).
   */
  const scanOne = async (inv: InvoiceGroup, runId: number, singleFlow = false) => {
    const controller = new AbortController();
    abortersRef.current.set(inv.id, controller);
    try {
      // A document already in the archive comes back instantly with its stored
      // extraction and a `priorScan` block — same shape, no second AI call.
      const result = (await scanInvoice(inv.files, controller.signal)) as ArchivedScanResult;
      if (runId !== runIdRef.current) return;
      applyScan(inv.id, result);
      if (singleFlow) {
        setStep("review");
        setShowPreview(true);
      }
    } catch (err: any) {
      if (runId !== runIdRef.current || controller.signal.aborted) return;
      console.error(err);
      const msg: string = err?.response?.data?.message ?? "";
      const code: string | undefined = err?.response?.data?.code;
      const isApiKeyError = code === "AI_KEY_INVALID" || /api key|anthropic/i.test(msg);
      if (singleFlow) {
        toast({
          title: isApiKeyError ? "Anthropic API key not configured" : "Failed to scan invoice",
          description: isApiKeyError
            ? "Go to Settings → AI & Integrations to add your Claude API key."
            : "Please check the file and try again.",
          variant: "error",
        });
        setStep("upload");
      } else {
        patchInvoiceById(inv.id, {
          status: "failed",
          error: isApiKeyError
            ? "Anthropic API key not configured — see Settings → AI & Integrations."
            : msg || "Scan failed. Retry, or check the file.",
        });
      }
    } finally {
      abortersRef.current.delete(inv.id);
    }
  };

  /** Concurrency-limited (3) scan pool — one failed invoice never kills the rest. */
  const runScanPool = async (invs: InvoiceGroup[], runId: number) => {
    const queue = [...invs];
    const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
      for (let inv = queue.shift(); inv; inv = queue.shift()) {
        if (runId !== runIdRef.current) return;
        await scanOne(inv, runId);
      }
    });
    await Promise.all(workers);
  };

  const retryInvoice = (id: string) => {
    const inv = invoicesRef.current.find((x) => x.id === id);
    if (!inv || inv.status !== "failed") return;
    patchInvoiceById(id, { status: "scanning", error: null });
    void scanOne({ ...inv }, runIdRef.current);
  };

  const processFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "image/heic",
      "image/heif",
      "application/pdf",
    ];
    // Some browsers/OSes label HEIC as empty MIME — fall back to extension sniff.
    const heicExt = /\.(heic|heif)$/i;
    const normalised: File[] = files.map((f) => {
      if (!f.type && heicExt.test(f.name)) {
        return new File([f], f.name, { type: "image/heic" });
      }
      return f;
    });
    const bad = normalised.find((f) => !allowed.includes(f.type));
    if (bad) {
      toast({
        title: "Unsupported file",
        description: `"${bad.name}" — accepted formats: JPEG, PNG, WebP, GIF, HEIC, PDF`,
        variant: "error",
      });
      return;
    }
    // Client-side size check — the server's Multer cap would otherwise surface
    // as an opaque network error.
    const tooBig = normalised.find((f) => f.size > MAX_FILE_BYTES);
    if (tooBig) {
      toast({
        title: "File too large",
        description: `"${tooBig.name}" is over 25MB. Compress or re-export it and try again.`,
        variant: "error",
      });
      return;
    }
    const groups = groupFiles(normalised);
    if (groups.some((g) => g.files.length > MAX_PAGES_PER_INVOICE)) {
      toast({
        title: "Too many pages",
        description: "Up to 10 pages per invoice. Split larger documents.",
        variant: "error",
      });
      return;
    }
    if (groups.length > MAX_INVOICES_PER_BATCH) {
      toast({
        title: "Too many invoices",
        description: `Up to ${MAX_INVOICES_PER_BATCH} invoices per batch. Scan the rest in a second batch.`,
        variant: "error",
      });
      return;
    }

    // Drop any previous session (aborts stale scans, revokes object URLs).
    discardSession();
    const runId = runIdRef.current;
    const newInvoices = groups.map((g) => makeInvoice(g.kind, g.files));
    setInvoices(newInvoices);

    if (newInvoices.length === 1) {
      // Today's exact single-invoice flow.
      setStep("processing");
      await scanOne(newInvoices[0], runId, true);
    } else {
      // Batch: land on review immediately; invoices fill in as scans finish.
      setStep("review");
      setShowPreview(true);
      await runScanPool(newInvoices, runId);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) void processFiles(files);
    // Reset so picking the same files again still triggers onChange
    e.target.value = "";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length > 0) void processFiles(files);
  };

  const updateItem = (i: number, patch: Partial<ReviewItem>) => {
    setReviewItems((prev) => prev.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  };

  const removeItem = (i: number) => {
    setReviewItems((prev) => prev.filter((_, idx) => idx !== i));
  };

  const addItem = () => {
    setReviewItems((prev) => [
      ...prev,
      {
        extractedName: "",
        productId: "",
        description: "",
        qty: "1",
        unitCost: "",
        lineTotal: null,
        extractedQty: "1",
        extractedUnitCost: "",
        confidence: "none",
      },
    ]);
  };

  /** unit is DERIVED from packSize > 1 — never stored as its own field. */
  const unitOfItem = (item: ReviewItem): ScanLineUnit =>
    (item.packSize ?? 0) > 1 ? "boxes" : "pieces";

  /**
   * Apply a DIRECT edit to qty/unitCost/packSize and re-canonicalize —
   * keeps `preConvert` in sync with whatever's actually on screen so the
   * NEXT toggle replays the edit rather than a stale extraction. Clears any
   * conversion warning from a now-superseded state.
   */
  const updateLineValue = (
    i: number,
    patch: Partial<Pick<ReviewItem, "qty" | "unitCost" | "packSize">>,
  ) => {
    setReviewItems((prev) =>
      prev.map((row, idx) => {
        if (idx !== i) return row;
        const next = { ...row, ...patch };
        return {
          ...next,
          preConvert: canonicalizeLine(next.qty, next.unitCost, next.packSize ?? null),
          unitWarning: undefined,
        };
      }),
    );
  };

  /**
   * Boxes/Pieces toggle: replays the row's canonical `preConvert` snapshot
   * through `toBillLine` — never re-derives it from the currently-displayed
   * qty/unitCost — so switching units repeatedly is lossless (A3).
   */
  const setLineUnit = (i: number, unit: ScanLineUnit) => {
    const item = reviewItems[i];
    const snap =
      item.preConvert ?? canonicalizeLine(item.qty, item.unitCost, item.packSize ?? null);
    const ppb = item.ppbDraft ?? item.packSize ?? undefined;
    const result = toBillLine(snap, unit, ppb, item.catalogUnitsPerBox ?? undefined);
    updateItem(i, {
      preConvert: snap,
      qty: String(result.qty),
      unitCost: String(result.unitCost),
      packSize: result.packSize,
      unitWarning: result.warning,
    });
  };

  /**
   * Edit the pieces-per-box draft (the case-size input beside the toggle).
   * While already in Boxes mode this live-recomputes the case qty/cost from
   * the canonical snapshot at the new size; in Pieces mode it just arms the
   * draft for the next switch to Boxes.
   */
  const setLinePpb = (i: number, ppb: number | null) => {
    const item = reviewItems[i];
    if (unitOfItem(item) !== "boxes") {
      // Just arming the draft — no conversion attempted yet, so any warning
      // from a PRIOR attempt no longer describes this (unattempted) value.
      updateItem(i, { ppbDraft: ppb, unitWarning: undefined });
      return;
    }
    const snap =
      item.preConvert ?? canonicalizeLine(item.qty, item.unitCost, item.packSize ?? null);
    const result = toBillLine(
      snap,
      "boxes",
      ppb ?? undefined,
      item.catalogUnitsPerBox ?? undefined,
    );
    updateItem(i, {
      ppbDraft: ppb,
      preConvert: snap,
      qty: String(result.qty),
      unitCost: String(result.unitCost),
      packSize: result.packSize,
      unitWarning: result.warning,
    });
  };

  const handleProductSelect = (
    i: number,
    productId: string,
    /**
     * The full product object from an async picker pick or a candidate chip.
     * Every caller passes one now (the async picker's onChange, the
     * candidate chips whose `name` is already the composed display name);
     * the create-from-line flow updates the row directly, not through here.
     */
    pickedProduct?: {
      id: string;
      name: string;
      sku?: string | null;
      /** Arms `ppbDraft` for the Boxes toggle — never silently sets packSize. */
      unitsPerBox?: number | null;
    },
  ) => {
    const item = reviewItems[i];
    const product = productId ? pickedProduct : undefined;
    if (product) {
      const catalogUnitsPerBox =
        product.unitsPerBox && product.unitsPerBox > 1 ? product.unitsPerBox : null;
      // Only update the product link + description.
      // Keep the invoice-extracted price — that is what the supplier is actually charging.
      // The product's averageCost is our historical average, not the current invoice price.
      updateItem(i, {
        productId,
        // Compose "<Parent> - <Variant>" so the bill line reads
        // meaningfully on its own (variants store just the variant
        // name in `product.name` per PR #44).
        description: displayProductName(product),
        // unitCost intentionally NOT overwritten — preserve the extracted invoice price
        // Changing the matched product invalidates any in-progress split.
        splits: undefined,
        // A manual pick is no longer a "remembered" match.
        matchSource: null,
        catalogUnitsPerBox,
        // Arm the Boxes draft from the catalog when the line doesn't already
        // have one of its own — but NEVER touch `packSize` here: linking a
        // product must not silently change the bill's actual unit.
        ppbDraft: item.ppbDraft ?? item.packSize ?? catalogUnitsPerBox,
      });
    } else {
      updateItem(i, {
        productId: "",
        description: item.extractedName,
        splits: undefined,
        matchSource: null,
        catalogUnitsPerBox: null,
      });
    }

    // Save the mapping so the AI learns from this correction
    const detectedSupplier = scanResult?.supplier;
    if (detectedSupplier && item.extractedName) {
      saveMapping.mutate({
        supplierName: detectedSupplier,
        rawDescription: item.extractedName,
        productId: productId || null,
      });
    }
  };

  /**
   * Open the variant-split panel on a row. Pre-allocates the full extracted
   * qty to the originally-matched variant so the operator only has to edit
   * the rows whose qty actually changed. Fetches (and caches) the sibling
   * family on demand — no longer blocked on the removed 1000-row preload.
   */
  const startSplit = async (i: number) => {
    const item = reviewItems[i];
    if (!item.productId || siblingLoadingId) return;
    let siblings = siblingCache[item.productId];
    if (!siblings) {
      setSiblingLoadingId(item.productId);
      try {
        siblings = await fetchVariantSiblings({
          id: item.productId,
          // description carries the composed display name for linked rows.
          name: item.description || item.extractedName || "",
        });
        setSiblingCache((prev) => ({ ...prev, [item.productId]: siblings! }));
      } catch {
        toast({
          title: "Couldn't load varieties",
          description: "Check your connection and try again.",
          variant: "error",
        });
        return;
      } finally {
        setSiblingLoadingId(null);
      }
    }
    const splits: VarietySplit[] = siblings.map((s) => ({
      productId: s.id,
      qty: s.id === item.productId ? item.qty : "0",
      name: s.name,
      variantName: s.variantName ?? null,
    }));
    updateItem(i, { splits });
  };

  const cancelSplit = (i: number) => {
    updateItem(i, { splits: undefined });
  };

  const updateSplitQty = (rowIdx: number, splitIdx: number, qty: string) => {
    setReviewItems((prev) =>
      prev.map((row, idx) => {
        if (idx !== rowIdx || !row.splits) return row;
        const next = row.splits.map((s, j) => (j === splitIdx ? { ...s, qty } : s));
        return { ...row, splits: next };
      }),
    );
  };

  /**
   * Manually add another product to a split (escape hatch when flavors
   * weren't tagged as variants in the catalog and weren't picked up by
   * the name-prefix grouping). Skips no-ops and duplicates. `product` comes
   * from the async picker's onChange second argument — always present on a
   * real pick, so the split entry is self-describing from the start.
   */
  const addSplitVariant = (
    rowIdx: number,
    productId: string,
    product?: { name: string; variantName?: string | null },
  ) => {
    if (!productId) return;
    setReviewItems((prev) =>
      prev.map((row, idx) => {
        if (idx !== rowIdx) return row;
        const splits = row.splits ?? [];
        if (splits.some((s) => s.productId === productId)) return row;
        return {
          ...row,
          splits: [
            ...splits,
            {
              productId,
              qty: "0",
              name: product?.name,
              variantName: product?.variantName ?? null,
            },
          ],
        };
      }),
    );
  };

  const removeSplit = (rowIdx: number, splitIdx: number) => {
    setReviewItems((prev) =>
      prev.map((row, idx) => {
        if (idx !== rowIdx || !row.splits) return row;
        const next = row.splits.filter((_, j) => j !== splitIdx);
        return { ...row, splits: next.length > 0 ? next : undefined };
      }),
    );
  };

  const splitSum = (splits: VarietySplit[] | undefined) =>
    (splits ?? []).reduce((s, x) => s + (parseFloat(x.qty) || 0), 0);

  // Money discipline: sum the RAW (unrounded) line amounts and round once at
  // the end — this must match the server's create() totalOwed computation
  // exactly (apps/api/src/vendor-bills/vendor-bills.service.ts), which also
  // sums raw qty*unitCost and rounds only the final total. Rounding each
  // line first (then summing the rounded values) can drift a cent from the
  // server's total whenever a line has a fractional qty or an unrounded
  // unit cost — and this value feeds the paired Expense.amount, which must
  // agree with the VendorBill.totalOwed for the same invoice.
  const invoiceTotalOf = (inv: InvoiceGroup) =>
    roundMoney(
      inv.reviewItems.reduce((s, item) => {
        const cost = parseFloat(item.unitCost) || 0;
        const qty =
          item.splits && item.splits.length > 0 ? splitSum(item.splits) : parseFloat(item.qty) || 0;
        return s + qty * cost;
      }, 0),
    );

  const computedTotal = active ? invoiceTotalOf(active) : 0;

  /**
   * Ask the server whether this supplier invoice was already recorded. Mirrors
   * what createOne() will post, so the answer matches the create-time guard:
   * the totals must agree for the supplier+date fallback match to line up.
   */
  const runDuplicateCheck = async (invoiceId: string, inv: InvoiceGroup, runId: number) => {
    const number = inv.invoiceNumber.trim();
    if (!number && !(inv.supplierId && inv.billDate)) {
      patchInvoiceById(invoiceId, { duplicate: null, duplicateCheckPending: false });
      return;
    }
    // Responses can land out of order while the operator retypes, so a result
    // only applies if the identity it was probed for is still the current one.
    const stale = () => {
      const current = invoicesRef.current.find((x) => x.id === invoiceId);
      return (
        runId !== runIdRef.current ||
        !current ||
        current.invoiceNumber.trim() !== number ||
        current.supplierId !== inv.supplierId
      );
    };
    patchInvoiceById(invoiceId, { duplicateCheckPending: true });
    try {
      const { duplicate } = await checkDuplicate.mutateAsync({
        supplierId: inv.supplierId || undefined,
        supplierInvoiceNumber: number || undefined,
        total: roundMoney(invoiceTotalOf(inv) + (inv.scanResult?.tax ?? 0)),
        billDate: inv.billDate || undefined,
      });
      if (stale()) return;
      patchInvoiceById(invoiceId, { duplicate, duplicateCheckPending: false });
    } catch {
      // A failed probe must never block the operator — create() re-checks
      // server-side and 409s, which the create path handles.
      if (stale()) return;
      patchInvoiceById(invoiceId, { duplicate: null, duplicateCheckPending: false });
    }
  };

  /**
   * A duplicate only matters when this invoice would actually create a bill —
   * an expense-only invoice restocks nothing, so it posts as normal.
   */
  const blockingDuplicateOf = (inv: InvoiceGroup) =>
    inv.createMode !== "expense" && !inv.allowDuplicate ? inv.duplicate : null;

  /**
   * Either "already in the system" signal — the number/fuzzy BILL match, or a
   * byte/line-level PRIOR SCAN that was POSTED. One predicate so the banners,
   * the navigator, the skip affordances and the create-all partition can never
   * disagree about what counts as pre-existing. ("Create anyway" lifts both —
   * the server's allowDuplicate flag bypasses both guards too.)
   */
  const alreadyInSystem = (inv: InvoiceGroup) =>
    !!blockingDuplicateOf(inv) ||
    (inv.createMode !== "expense" &&
      !inv.allowDuplicate &&
      inv.scanResult?.priorScan?.status === "POSTED" &&
      !!inv.scanResult.priorScan.vendorBillId);

  /** Drop ONE pre-existing invoice from the batch. Reversible (undo / editing
   *  the invoice number restores it) — never removes the group from the array. */
  const skipInvoice = (id: string) => patchInvoiceById(id, { status: "skipped" });
  const unskipInvoice = (id: string) => patchInvoiceById(id, { status: "scanned" });

  /** How many reviewable invoices are known pre-existing right now. */
  const skippableDupCount = invoices.filter(
    (inv) => inv.status === "scanned" && alreadyInSystem(inv),
  ).length;

  /** Batch affordance: drop every known pre-existing invoice in one tap. */
  const skipAllDuplicates = () =>
    setInvoices((prev) =>
      prev.map((inv) =>
        inv.status === "scanned" && alreadyInSystem(inv)
          ? { ...inv, status: "skipped" as const }
          : inv,
      ),
    );

  /** Debounced re-check while the operator retypes the invoice # or swaps supplier. */
  const scheduleDuplicateCheck = (invoiceId: string) => {
    const existing = dupTimersRef.current.get(invoiceId);
    if (existing) clearTimeout(existing);
    const runId = runIdRef.current;
    dupTimersRef.current.set(
      invoiceId,
      setTimeout(() => {
        dupTimersRef.current.delete(invoiceId);
        if (runId !== runIdRef.current) return;
        const inv = invoicesRef.current.find((x) => x.id === invoiceId);
        if (inv) void runDuplicateCheck(invoiceId, inv, runId);
      }, 500),
    );
  };

  // A row is "valid" if either (a) it has a description + qty, or
  // (b) it's been split and at least one split has qty > 0.
  const validItemsOf = (inv: InvoiceGroup) =>
    inv.reviewItems.filter((item) => {
      if (item.splits && item.splits.length > 0) {
        return item.splits.some((s) => parseFloat(s.qty) > 0);
      }
      return item.description && parseFloat(item.qty) > 0;
    });

  const invoiceValidationError = (inv: InvoiceGroup): string | null => {
    const wantsBill = inv.createMode === "bill" || inv.createMode === "both";
    const wantsExpense = inv.createMode === "expense" || inv.createMode === "both";
    if (wantsBill && !inv.supplierId) return "Please select a supplier before creating the bill.";
    if (wantsBill && validItemsOf(inv).length === 0)
      return "Add at least one valid line item for the vendor bill";
    if (wantsExpense && !inv.expenseCategoryId) return "Select an expense category";
    return null;
  };

  /** Short human label for an invoice in confirms/toasts. */
  const invoiceLabel = (inv: InvoiceGroup) =>
    inv.scanResult?.supplier ??
    (inv.invoiceNumber ? `#${inv.invoiceNumber}` : (inv.pagePreviews[0]?.name ?? "Invoice"));

  // Expand split rows: one VendorBillItem per non-zero variant entry.
  // Split entries inherit the row's unitCost AND packSize — the split divides
  // the case count across flavors, so each part stays in the line's case
  // denomination (dropping packSize would receive cases as pieces). They
  // deliberately carry NO sku/lineTotal: the printed code and amount describe
  // the whole line, and copying them onto each part would claim one item code
  // maps to several products.
  const buildBillItems = (inv: InvoiceGroup): CreateVendorBillItem[] =>
    validItemsOf(inv).flatMap((item): CreateVendorBillItem[] => {
      if (item.splits && item.splits.length > 0) {
        return item.splits
          .filter((s) => parseFloat(s.qty) > 0)
          .map((s) => ({
            productId: s.productId,
            description: s.name ?? item.description,
            qty: parseFloat(s.qty) || 0,
            unitCost: parseFloat(item.unitCost) || 0,
            packSize: item.packSize ?? undefined,
          }));
      }
      return [
        {
          productId: item.productId || undefined,
          description: item.description,
          qty: parseFloat(item.qty) || 1,
          unitCost: parseFloat(item.unitCost) || 0,
          // As printed on the invoice, kept verbatim. An operator correction to
          // qty/unitCost doesn't rewrite them — the document still says what it
          // says, and `sku` is what matches this line next time.
          sku: item.sku?.trim() || undefined,
          packSize: item.packSize ?? undefined,
          lineTotal: item.lineTotal ?? undefined,
        },
      ];
    });

  /**
   * Post one invoice: create bill → receive → (expense), each step guarded by
   * an idempotency flag so a retried Create never re-posts what already
   * succeeded (a "both"-mode expense failure must not duplicate the bill).
   * Reads the invoice fresh from invoicesRef so retries see prior progress.
   */
  const createOne = async (
    invoiceId: string,
  ): Promise<{ ok: boolean; duplicate: boolean; notes: string[] }> => {
    const inv = invoicesRef.current.find((x) => x.id === invoiceId);
    if (!inv) return { ok: false, duplicate: false, notes: [] };
    const wantsBill = inv.createMode === "bill" || inv.createMode === "both";
    const wantsExpense = inv.createMode === "expense" || inv.createMode === "both";
    const notes: string[] = [];

    try {
      let billId = inv.createdBillId;
      if (wantsBill && !billId) {
        const billItems = buildBillItems(inv);
        const scannedTax = inv.scanResult?.tax ?? 0;
        const scannedSubtotal = inv.scanResult?.subtotal ?? 0;
        const bill = await createBill.mutateAsync({
          supplierId: inv.supplierId,
          billDate: inv.billDate,
          dueDate: inv.dueDate || "",
          items: billItems,
          // Persist the supplier's own invoice number — it's how the operator
          // reconciles against the supplier statement later.
          notes: inv.invoiceNumber ? `Supplier invoice #${inv.invoiceNumber}` : undefined,
          supplierInvoiceNumber: inv.invoiceNumber.trim() || undefined,
          allowDuplicate: inv.allowDuplicate || undefined,
          // Sales tax is owed too; the server folds it into totalOwed (line
          // items only carry the pre-tax unit costs).
          taxAmount: scannedTax > 0 ? roundMoney(scannedTax) : undefined,
          // Pre-tax total as the invoice printed it — stored as evidence; the
          // amount owed is still summed from the lines.
          subtotal: scannedSubtotal > 0 ? roundMoney(scannedSubtotal) : undefined,
          // Closes the loop from bill back to the document it came from, and
          // marks that scan POSTED so the archive stops offering it as unfinished.
          scanId: inv.scanResult?.scanId ?? undefined,
        });
        billId = (bill as { id?: string })?.id ?? null;
        patchInvoiceById(invoiceId, { createdBillId: billId });
        // Auto-receive: transitions DRAFT → RECEIVED, which triggers stock movements
        // and recalculates average cost for every product-linked line item.
        const matchedItems = billItems.filter((it) => it.productId).length;
        if (billId) {
          try {
            // acknowledgeUnlinked is safe here: with unlinked lines present the
            // operator explicitly confirmed up front; without them it's a no-op.
            await receiveBill.mutateAsync({ id: billId, acknowledgeUnlinked: true });
            notes.push(
              matchedItems > 0
                ? `Vendor bill received — inventory updated for ${matchedItems} item${matchedItems === 1 ? "" : "s"}`
                : "Vendor bill received",
            );
          } catch (receiveErr: unknown) {
            // Bill was created but receive failed — surface the issue but don't lose the bill
            const rmsg =
              (receiveErr as { response?: { data?: { message?: string } } })?.response?.data
                ?.message ??
              "created in Draft (could not auto-receive — open the bill and click Receive to update stock)";
            notes.push(`Vendor bill ${rmsg}`);
          }
        } else {
          notes.push("Vendor bill created");
        }
      }

      if (wantsExpense && !inv.expenseCreated) {
        // The expense records the money actually spent — include detected tax.
        const expenseTotal = wantsBill
          ? roundMoney(invoiceTotalOf(inv) + (inv.scanResult?.tax ?? 0))
          : roundMoney(inv.scanResult?.total ?? invoiceTotalOf(inv));
        await createExpense.mutateAsync({
          categoryId: inv.expenseCategoryId,
          supplierId: inv.supplierId || undefined,
          amount: expenseTotal,
          date: inv.expenseDate,
          description: inv.expenseDescription || inv.scanResult?.supplier || undefined,
          paymentMethod: inv.expensePaymentMethod,
          notes: inv.expenseNotes || undefined,
          referenceNumber: inv.invoiceNumber || undefined,
        });
        patchInvoiceById(invoiceId, { expenseCreated: true });
        notes.push("Expense recorded");
      }

      patchInvoiceById(invoiceId, { status: "created", error: null });
      return { ok: true, duplicate: false, notes };
    } catch (err: any) {
      // The pre-flight probe can't see a bill created moments ago by an earlier
      // invoice in this same batch, so the server's 409 is the only signal that
      // the number repeats within the batch. Stamp it and let the loop go on.
      const dup = getDuplicateVendorBillError(err);
      if (dup) {
        patchInvoiceById(invoiceId, {
          duplicate: dup.duplicate,
          duplicateCheckPending: false,
          error: null,
        });
        return { ok: false, duplicate: true, notes };
      }
      const msg =
        err?.response?.data?.message ||
        err?.message ||
        "Failed to create records. Please try again.";
      // Keep status "scanned" so the invoice stays editable + creatable.
      patchInvoiceById(invoiceId, { error: msg });
      return { ok: false, duplicate: false, notes };
    }
  };

  const handleCreateAll = async () => {
    const targets = invoices
      .map((inv, index) => ({ inv, index }))
      .filter(({ inv }) => inv.status === "scanned");
    if (targets.length === 0 || isSubmittingAll) return;

    // A known pre-existing invoice (bill match OR posted prior scan) is left
    // alone rather than blocking the batch: the rest still post, and the
    // operator resolves it from the banner — open the existing bill, Skip it,
    // or override with "Create anyway".
    const postable = targets.filter(({ inv }) => !alreadyInSystem(inv));
    if (postable.length === 0) {
      // Everything left is already in the system. Offer to drop the lot and
      // finish — the old dead end (toast + return) forced a per-invoice grind.
      const proceed = window.confirm(
        targets.length === 1
          ? "This invoice is already recorded. Skip it and close?"
          : `All ${targets.length} remaining invoices are already recorded. Skip them and close?`,
      );
      if (proceed) {
        skipAllDuplicates();
        toast({
          title:
            targets.length === 1
              ? "Skipped — already recorded"
              : `Skipped ${targets.length} already-recorded invoices`,
          description: "Nothing new to create. The existing bills are untouched.",
          variant: "success",
        });
        onCreated?.();
        onClose();
        return;
      }
      const firstDup = invoices.findIndex(
        (inv) => inv.status === "scanned" && alreadyInSystem(inv),
      );
      if (firstDup >= 0) {
        setActiveIndex(firstDup);
        setCreateFromRow(null);
      }
      toast({
        title:
          targets.length === 1
            ? "This invoice was already recorded"
            : `All ${targets.length} invoices were already recorded`,
        description:
          "Open the existing bill, Skip this invoice, or choose Create anyway to record it a second time.",
        variant: "warning",
      });
      return;
    }

    // Pre-validate everything up front: nothing posts until every target is valid.
    for (const { inv, index } of postable) {
      const problem = invoiceValidationError(inv);
      if (problem) {
        setActiveIndex(index);
        setCreateFromRow(null);
        toast({
          title: targets.length > 1 ? `${invoiceLabel(inv)}: ${problem}` : problem,
          variant: "error",
        });
        return;
      }
    }

    // Unlinked lines never restock — make skipping them an EXPLICIT choice
    // instead of silently acknowledging on the operator's behalf. One
    // aggregated confirm across the batch; Cancel aborts before anything posts.
    const unlinked = postable
      .filter(({ inv }) => inv.createMode === "bill" || inv.createMode === "both")
      .map(({ inv }) => ({
        inv,
        count: buildBillItems(inv).filter((it) => !it.productId).length,
      }))
      .filter((x) => x.count > 0);
    if (unlinked.length > 0) {
      const total = unlinked.reduce((s, x) => s + x.count, 0);
      const header =
        `${total} line${total === 1 ? "" : "s"} ${total === 1 ? "isn't" : "aren't"} linked to a ` +
        `product and won't update stock or costs.`;
      const detail =
        invoices.length > 1
          ? "\n" + unlinked.map((x) => `• ${invoiceLabel(x.inv)}: ${x.count}`).join("\n") + "\n"
          : "";
      const proceed = window.confirm(
        `${header}\n${detail}\nLink or create products for them first, or click OK to create & receive anyway.`,
      );
      if (!proceed) return;
    }

    setIsSubmittingAll(true);
    try {
      let created = 0;
      let failed = 0;
      // Two very different kinds of "not posted": autoSkipped = still-blocked
      // duplicates the operator hasn't resolved (unfinished work → keep the
      // modal open); dropped = invoices the operator explicitly Skipped (a
      // completed decision — they must never hold the batch hostage).
      let autoSkipped = targets.length - postable.length;
      const allNotes: string[] = [];
      for (const { inv } of postable) {
        const { ok, duplicate, notes } = await createOne(inv.id);
        if (ok) created++;
        else if (duplicate) autoSkipped++;
        else failed++;
        allNotes.push(...notes);
      }
      const dropped = invoicesRef.current.filter((x) => x.status === "skipped").length;
      // Invoices that couldn't be posted this pass (scan failed / still scanning)
      // must not vanish with the modal — keep it open so they can be retried.
      // "skipped" is deliberately NOT counted: a dropped duplicate is done.
      const leftBehind = invoicesRef.current.filter(
        (x) => x.status === "failed" || x.status === "scanning",
      ).length;
      const droppedNote = dropped > 0 ? `${dropped} skipped as already recorded` : "";
      if (failed === 0 && autoSkipped === 0 && leftBehind === 0) {
        toast({
          title:
            targets.length === 1 && created === 1
              ? allNotes.join(" & ") + " successfully!"
              : `Created ${created} invoice${created === 1 ? "" : "s"} successfully!`,
          description:
            [targets.length > 1 ? allNotes.join(" · ") : "", droppedNote]
              .filter(Boolean)
              .join(" · ") || undefined,
          variant: "success",
        });
        onCreated?.();
        onClose();
      } else if (failed === 0 && autoSkipped === 0) {
        // NOTE: onCreated is deliberately NOT called on the keep-open branches —
        // both entry points close the modal in that callback, which would strand
        // the not-yet-posted invoices. The mutation hooks already invalidate the
        // affected queries, so the lists behind the modal stay fresh.
        toast({
          title: `Created ${created} invoice${created === 1 ? "" : "s"}`,
          description: `${leftBehind} invoice${leftBehind === 1 ? "" : "s"} in this batch still need${leftBehind === 1 ? "s" : ""} a successful scan — retry or discard.`,
          variant: "warning",
        });
      } else {
        // Keep the modal open: unresolved duplicates and failed invoices stay
        // editable, succeeded ones are marked created and will be skipped on
        // the next attempt.
        const firstUnposted = invoicesRef.current.findIndex((x) => x.status === "scanned");
        if (firstUnposted >= 0) {
          setActiveIndex(firstUnposted);
          setCreateFromRow(null);
        }
        const tail = [
          autoSkipped > 0 ? `${autoSkipped} already recorded (resolve or skip)` : "",
          droppedNote,
          failed > 0 ? `${failed} failed` : "",
        ]
          .filter(Boolean)
          .join(", ");
        toast({
          title: `Created ${created} of ${targets.length} — ${tail}`,
          description: [
            autoSkipped > 0
              ? "Already-recorded invoices weren't posted — open the existing bill, Skip this invoice, or use Create anyway to record one a second time."
              : "",
            failed > 0
              ? "Fix the failed invoices and click Create again. Already-created bills won't be duplicated."
              : "",
          ]
            .filter(Boolean)
            .join(" "),
          variant: failed > 0 && created === 0 ? "error" : "warning",
        });
      }
    } finally {
      setIsSubmittingAll(false);
    }
  };

  const isPending =
    isSubmittingAll || createBill.isPending || receiveBill.isPending || createExpense.isPending;

  // Footer derivations for the multi-invoice batch
  const creatable = invoices.filter((inv) => inv.status === "scanned");
  const creatableBills = creatable.filter(
    (inv) => inv.createMode === "bill" || inv.createMode === "both",
  ).length;
  const creatableExpenses = creatable.filter(
    (inv) => inv.createMode === "expense" || inv.createMode === "both",
  ).length;
  const batchTotal = roundMoney(creatable.reduce((s, inv) => s + invoiceTotalOf(inv), 0));
  const createLabel =
    invoices.length <= 1
      ? createMode === "bill"
        ? "Create Vendor Bill"
        : createMode === "expense"
          ? "Record Expense"
          : "Create Bill & Expense"
      : "Create " +
        ([
          creatableBills > 0 ? `${creatableBills} bill${creatableBills === 1 ? "" : "s"}` : "",
          creatableExpenses > 0
            ? `${creatableExpenses} expense${creatableExpenses === 1 ? "" : "s"}`
            : "",
        ]
          .filter(Boolean)
          .join(" + ") || "bills");

  const handleScanAgain = () => {
    const hasWork = invoices.some((inv) => inv.status === "scanned" || inv.status === "created");
    if (
      hasWork &&
      !window.confirm(
        "Start over? This discards the scanned invoices and any edits. Bills you already created are kept.",
      )
    ) {
      return;
    }
    discardSession();
    setStep("upload");
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-brand-500" />
            <h2 className="text-lg font-semibold text-navy">AI Invoice Scanner</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-navy/70 transition-colors hover:bg-surface-raised hover:text-navy"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {/* Upload Step */}
          {step === "upload" && (
            <div className="p-6">
              <p className="mb-4 text-sm text-navy/70">
                Upload vendor invoices — drop several PDFs to scan <b>each as its own invoice</b>{" "}
                (one vendor bill per PDF), or photograph the pages of one invoice as images. Claude
                will extract every line item and match them to your catalog.
              </p>
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={cn(
                  "flex cursor-pointer flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed py-16 transition-colors",
                  isDragging
                    ? "border-brand-500 bg-brand-50"
                    : "border-surface-border bg-surface-raised hover:border-brand-300 hover:bg-brand-50/50",
                )}
              >
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-100">
                  <Upload className="h-7 w-7 text-brand-500" />
                </div>
                <div className="text-center">
                  <p className="font-medium text-navy">Drop invoices here</p>
                  <p className="mt-1 text-sm text-navy/70">
                    or click to browse — each PDF becomes its own invoice; images group as pages of
                    one invoice
                  </p>
                  <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
                    {["PDF", "JPEG", "PNG", "HEIC", "WebP", "GIF"].map((label) => (
                      <span
                        key={label}
                        className="inline-flex items-center gap-1 rounded-full bg-white/80 px-2 py-0.5 text-xs font-medium text-navy/70 ring-1 ring-surface-border"
                      >
                        {label === "PDF" && <FileText className="h-3 w-3" />}
                        {label}
                      </span>
                    ))}
                  </div>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,application/pdf,.heic,.heif"
                  className="hidden"
                  onChange={handleFileChange}
                />
              </div>
              <p className="mt-4 text-center text-xs text-navy/70">
                <Sparkles className="inline h-3 w-3" /> Powered by Claude AI • Up to 10 pages per
                invoice, {MAX_INVOICES_PER_BATCH} invoices per batch • HEIC iPhone photos supported
              </p>
            </div>
          )}

          {/* Processing Step */}
          {step === "processing" && (
            <div className="flex flex-col items-center justify-center gap-4 py-20">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-brand-50">
                <Loader2 className="h-8 w-8 animate-spin text-brand-500" />
              </div>
              <div className="text-center">
                <p className="font-semibold text-navy">Analyzing invoice...</p>
                <p className="mt-1 text-sm text-navy/70">
                  Claude AI is extracting items and matching products
                </p>
              </div>
            </div>
          )}

          {/* Review Step */}
          {step === "review" && (
            <div className="flex h-full min-h-0 flex-1 flex-col">
              {/* Batch navigator: switches BOTH the preview and the review form */}
              {invoices.length > 1 && (
                <InvoiceNavigator
                  invoices={invoices}
                  activeIndex={activeIndex}
                  disabled={isPending}
                  skippableDupCount={skippableDupCount}
                  onSkipAll={skipAllDuplicates}
                  onNavigate={(i) => {
                    setActiveIndex(Math.max(0, Math.min(invoices.length - 1, i)));
                    setCreateFromRow(null);
                  }}
                />
              )}
              <div className="flex min-h-0 flex-1">
                {/* Left: Invoice Preview */}
                {previewUrl && showPreview && (
                  <div className="flex w-1/3 shrink-0 flex-col border-r border-surface-border bg-surface-raised">
                    <div className="flex items-center justify-between border-b border-surface-border px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-brand-500" />
                        <span className="text-xs font-semibold uppercase tracking-wide text-navy/70">
                          Invoice Preview
                          {pagePreviews.length > 1 && (
                            <span className="ml-1.5 rounded-full bg-brand-100 px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-brand-700">
                              Page {previewIndex + 1} of {pagePreviews.length}
                            </span>
                          )}
                        </span>
                      </div>
                      <button
                        onClick={() => setShowPreview(false)}
                        className="rounded p-1 text-navy/30 hover:text-navy transition-colors"
                        title="Hide preview"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {pagePreviews.length > 1 && (
                      <div className="flex items-center justify-between border-b border-surface-border bg-white/60 px-3 py-1.5">
                        <button
                          type="button"
                          onClick={() => setPreviewIndex((i) => Math.max(0, i - 1))}
                          disabled={previewIndex === 0}
                          className="rounded px-2 py-0.5 text-xs font-medium text-brand-600 transition-colors hover:bg-brand-50 disabled:cursor-not-allowed disabled:text-navy/20 disabled:hover:bg-transparent"
                        >
                          ← Prev
                        </button>
                        <span
                          className="truncate px-2 text-[11px] text-navy/70"
                          title={pagePreviews[previewIndex]?.name}
                        >
                          {pagePreviews[previewIndex]?.name}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setPreviewIndex((i) => Math.min(pagePreviews.length - 1, i + 1))
                          }
                          disabled={previewIndex === pagePreviews.length - 1}
                          className="rounded px-2 py-0.5 text-xs font-medium text-brand-600 transition-colors hover:bg-brand-50 disabled:cursor-not-allowed disabled:text-navy/20 disabled:hover:bg-transparent"
                        >
                          Next →
                        </button>
                      </div>
                    )}
                    <div className="flex-1 overflow-hidden">
                      {previewType === "pdf" ? (
                        <iframe
                          src={previewUrl ?? undefined}
                          className="h-full w-full"
                          style={{ minHeight: "500px" }}
                          title="Invoice PDF"
                        />
                      ) : (
                        (() => {
                          const currentName = pagePreviews[previewIndex]?.name ?? "";
                          const isHeic = /\.(heic|heif)$/i.test(currentName);
                          if (isHeic) {
                            // Most browsers can't render HEIC in <img>. Show a clear placeholder
                            // — Claude still receives and processes the image server-side.
                            return (
                              <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
                                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-100">
                                  <FileText className="h-6 w-6 text-brand-500" />
                                </div>
                                <p className="text-sm font-medium text-navy">{currentName}</p>
                                <p className="text-xs text-navy/70">
                                  HEIC preview isn&apos;t supported in this browser, but the page
                                  was uploaded and Claude is reading it.
                                </p>
                              </div>
                            );
                          }
                          return (
                            <div className="flex h-full items-start justify-center overflow-auto p-2">
                              <img
                                src={previewUrl ?? undefined}
                                alt={`Invoice page ${previewIndex + 1}`}
                                className="max-w-full rounded object-contain"
                              />
                            </div>
                          );
                        })()
                      )}
                    </div>
                  </div>
                )}
                {/* Right: Form — full width when preview hidden */}
                <div
                  className={
                    previewUrl && showPreview ? "flex-1 overflow-y-auto" : "w-full overflow-y-auto"
                  }
                >
                  {active?.status === "scanning" ? (
                    <div className="flex flex-col items-center justify-center gap-4 py-20">
                      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-brand-50">
                        <Loader2 className="h-8 w-8 animate-spin text-brand-500" />
                      </div>
                      <div className="text-center">
                        <p className="font-semibold text-navy">Analyzing invoice...</p>
                        <p className="mt-1 text-sm text-navy/70">
                          Claude AI is extracting items and matching products
                        </p>
                      </div>
                    </div>
                  ) : active?.status === "failed" ? (
                    <div className="flex flex-col items-center justify-center gap-4 py-20">
                      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-danger-bg">
                        <AlertCircle className="h-8 w-8 text-danger" />
                      </div>
                      <div className="max-w-md text-center">
                        <p className="font-semibold text-navy">Couldn&apos;t scan this invoice</p>
                        <p className="mt-1 text-sm text-navy/70">{active.error}</p>
                      </div>
                      <Button variant="secondary" onClick={() => retryInvoice(active.id)}>
                        <RefreshCw className="h-4 w-4" /> Retry scan
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-4 p-6">
                      {active?.status === "created" && (
                        <div className="flex items-start gap-2 rounded-lg border border-green-200 bg-green-50 p-3">
                          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                          <p className="text-xs text-green-700">
                            Created — this invoice is done and won&apos;t be posted again.
                          </p>
                        </div>
                      )}
                      {active?.status === "skipped" && (
                        <div
                          className="flex items-start justify-between gap-2 rounded-lg border border-surface-border bg-surface-raised p-3"
                          data-testid="duplicate-skipped"
                        >
                          <p className="text-xs text-navy/70">
                            Skipped — already recorded
                            {active.duplicate?.billNumber
                              ? ` as ${active.duplicate.billNumber}`
                              : active.scanResult?.priorScan?.billNumber
                                ? ` as ${active.scanResult.priorScan.billNumber}`
                                : ""}
                            . It won&apos;t be posted with this batch.
                          </p>
                          <button
                            type="button"
                            onClick={() => unskipInvoice(active.id)}
                            disabled={isPending}
                            className="flex shrink-0 items-center gap-1 text-xs font-medium text-brand-600 transition-colors hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            <Undo2 className="h-3.5 w-3.5" />
                            Undo skip
                          </button>
                        </div>
                      )}
                      {active?.status !== "created" &&
                        active?.status !== "skipped" &&
                        scanResult?.priorScan && (
                          <PriorScanBanner
                            prior={scanResult.priorScan}
                            disabled={isPending}
                            onSkip={active ? () => skipInvoice(active.id) : undefined}
                          />
                        )}
                      {active?.status === "scanned" && active.error && (
                        <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-bg p-3">
                          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
                          <p className="text-xs text-danger">{active.error}</p>
                        </div>
                      )}
                      {scanResult?.notes && (
                        <div className="flex items-start gap-2 rounded-lg border border-yellow-200 bg-yellow-50 p-3">
                          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600" />
                          <p className="text-xs text-yellow-700">{scanResult.notes}</p>
                        </div>
                      )}

                      {/* Create mode selector */}
                      <div>
                        <p className="mb-2 text-sm font-semibold text-navy">
                          What would you like to create?
                        </p>
                        <div className="grid grid-cols-3 gap-3">
                          {(
                            [
                              {
                                value: "bill",
                                label: "Vendor Bill",
                                sub: "Adds to inventory and updates costs",
                                icon: ShoppingCart,
                              },
                              {
                                value: "expense",
                                label: "Expense",
                                sub: "Bookkeeping only — no stock change",
                                icon: Receipt,
                              },
                              {
                                value: "both",
                                label: "Both",
                                sub: "Inventory + bookkeeping in one go",
                                icon: Sparkles,
                              },
                            ] as const
                          ).map(({ value, label, sub, icon: Icon }) => (
                            <button
                              key={value}
                              onClick={() => setCreateMode(value)}
                              className={cn(
                                "flex flex-col items-start gap-1.5 rounded-xl border-2 px-4 py-3 text-left transition-all",
                                createMode === value
                                  ? "border-brand-500 bg-brand-50 text-brand-700 shadow-sm"
                                  : "border-surface-border bg-white text-navy hover:border-brand-200 hover:bg-brand-50/30",
                              )}
                            >
                              <div className="flex items-center gap-2">
                                <Icon className="h-4 w-4" />
                                <span className="text-sm font-semibold">{label}</span>
                              </div>
                              <span className="text-xs leading-snug text-current/70">{sub}</span>
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Shared header: supplier + dates */}
                      <div className="grid grid-cols-2 gap-4 rounded-xl border border-surface-border bg-surface-raised p-4">
                        <div>
                          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-navy">
                            Supplier
                          </label>
                          <SupplierSelect
                            value={supplierId}
                            onChange={setSupplierId}
                            suppliers={suppliers}
                          />
                          {scanResult?.supplier && (
                            <p className="mt-1 text-xs text-navy/70">
                              Detected: {scanResult.supplier}
                              {active?.supplierMatchAmbiguous && !supplierId && (
                                <span className="font-medium text-amber-600">
                                  {" "}
                                  — several suppliers match, pick one
                                </span>
                              )}
                            </p>
                          )}
                          <div className="mt-2">
                            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-navy">
                              Supplier Invoice #
                            </label>
                            <input
                              type="text"
                              value={invoiceNumber}
                              onChange={(e) => setInvoiceNumber(e.target.value)}
                              placeholder="From the invoice — saved for reconciliation"
                              className="w-full rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-brand-500"
                            />
                            {active && createMode !== "expense" && (
                              <DuplicateBanner
                                duplicate={active.duplicate}
                                pending={active.duplicateCheckPending}
                                allowDuplicate={active.allowDuplicate}
                                disabled={isPending}
                                onAllow={() => updateActive({ allowDuplicate: true })}
                                onUndo={() => updateActive({ allowDuplicate: false })}
                                onSkip={() => skipInvoice(active.id)}
                              />
                            )}
                          </div>
                        </div>
                        {createMode === "bill" || createMode === "both" ? (
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-navy">
                                Bill Date
                              </label>
                              <input
                                type="date"
                                value={billDate}
                                onChange={(e) => setBillDate(e.target.value)}
                                className="w-full rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                              />
                            </div>
                            <div>
                              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-navy">
                                Due Date
                              </label>
                              <input
                                type="date"
                                value={dueDate}
                                onChange={(e) => setDueDate(e.target.value)}
                                className="w-full rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                              />
                            </div>
                          </div>
                        ) : (
                          <div>
                            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-navy">
                              Expense Date
                            </label>
                            <input
                              type="date"
                              value={expenseDate}
                              onChange={(e) => setExpenseDate(e.target.value)}
                              className="w-full rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                            />
                          </div>
                        )}
                      </div>

                      {/* Expense-only fields */}
                      {(createMode === "expense" || createMode === "both") && (
                        <div className="grid grid-cols-2 gap-4 rounded-xl border border-brand-100 bg-brand-50/40 p-4">
                          <div>
                            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-navy">
                              Expense Category <span className="text-danger">*</span>
                            </label>
                            <select
                              value={expenseCategoryId}
                              onChange={(e) => setExpenseCategoryId(e.target.value)}
                              className="w-full rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                            >
                              <option value="">— Select category —</option>
                              {categories.map((c: { id: string; name: string }) => (
                                <option key={c.id} value={c.id}>
                                  {c.name}
                                </option>
                              ))}
                            </select>
                            {scanResult?.expenseCategory && (
                              <p className="mt-1 text-xs text-navy/70">
                                Detected: {scanResult.expenseCategory}
                              </p>
                            )}
                          </div>
                          <div>
                            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-navy">
                              Payment Method
                            </label>
                            <select
                              value={expensePaymentMethod}
                              onChange={(e) => setExpensePaymentMethod(e.target.value)}
                              className="w-full rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                            >
                              {SELECTABLE_PAYMENT_METHODS.map((m) => (
                                <option key={m} value={m}>
                                  {PAYMENT_METHOD_LABELS[m]}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="col-span-2">
                            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-navy">
                              Description
                            </label>
                            <input
                              type="text"
                              value={expenseDescription}
                              onChange={(e) => setExpenseDescription(e.target.value)}
                              placeholder="e.g. Office supplies from Acme Corp"
                              className="w-full rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-brand-500"
                            />
                          </div>
                        </div>
                      )}

                      {/* Line Items (shown for bill or both modes) */}
                      {(createMode === "bill" || createMode === "both") && (
                        <div>
                          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
                            <div>
                              <h3 className="flex items-center gap-2 text-base font-semibold text-navy">
                                Line items
                                <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-medium text-brand-700">
                                  {reviewItems.length}
                                </span>
                              </h3>
                              <p className="mt-0.5 text-xs text-navy/70">
                                Matched products will be added to inventory when you create the
                                bill.
                              </p>
                              {(() => {
                                const unmatched = reviewItems.filter((it) => !it.productId).length;
                                return unmatched > 0 ? (
                                  <div
                                    className="mt-2 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5"
                                    data-testid="unmatched-banner"
                                  >
                                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                                    <p className="text-xs text-amber-800">
                                      <span className="font-semibold">
                                        {unmatched} item{unmatched === 1 ? "" : "s"} didn&apos;t
                                        match any product.
                                      </span>{" "}
                                      Link each to an existing product, create a new product from
                                      the line, or leave it as a custom line — custom lines never
                                      update stock or costs.
                                    </p>
                                  </div>
                                ) : null;
                              })()}
                            </div>
                            {previewUrl && (
                              <button
                                type="button"
                                onClick={() => setShowPreview((v) => !v)}
                                className="flex items-center gap-1.5 rounded-lg border border-surface-border bg-white px-3 py-1.5 text-xs font-medium text-navy transition-colors hover:border-brand-300 hover:text-brand-600"
                              >
                                <FileText className="h-3.5 w-3.5" />
                                {showPreview ? "Hide invoice" : "View invoice"}
                              </button>
                            )}
                          </div>
                          <div className="overflow-x-auto rounded-xl border border-surface-border">
                            {/*
                      table-fixed forces explicit column widths to be honored — without
                      it, the Product cell's <select> stretches and starves the
                      narrow numeric columns. Min-width keeps numeric inputs readable
                      even when the modal is preview-open and the right pane is ~580px.
                    */}
                            <table className="w-full table-fixed text-sm" style={{ minWidth: 720 }}>
                              <colgroup>
                                <col />
                                <col style={{ width: 116 }} />
                                <col style={{ width: 104 }} />
                                <col style={{ width: 132 }} />
                                <col style={{ width: 108 }} />
                                <col style={{ width: 44 }} />
                              </colgroup>
                              <thead>
                                <tr className="border-b border-surface-border bg-surface-raised">
                                  <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-navy/70">
                                    Product
                                  </th>
                                  <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-navy/70">
                                    Match
                                  </th>
                                  <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-navy/70">
                                    Qty
                                  </th>
                                  <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-navy/70">
                                    Unit Price
                                  </th>
                                  <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-navy/70">
                                    Line Total
                                  </th>
                                  <th className="px-2 py-2.5" />
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-surface-border">
                                {reviewItems.map((item, i) => {
                                  const isSplit = !!(item.splits && item.splits.length > 0);
                                  const splitTotal = isSplit ? splitSum(item.splits) : 0;
                                  const effectiveQty = isSplit
                                    ? splitTotal
                                    : parseFloat(item.qty) || 0;
                                  const cost = parseFloat(item.unitCost) || 0;
                                  const calculated =
                                    effectiveQty > 0 && cost > 0 ? effectiveQty * cost : null;
                                  const invoiceTotal = item.lineTotal;
                                  const qtyChanged =
                                    !isSplit &&
                                    item.qty !== item.extractedQty &&
                                    item.extractedQty &&
                                    item.extractedQty !== "1";
                                  const costChanged =
                                    item.unitCost !== item.extractedUnitCost &&
                                    item.extractedUnitCost;
                                  // Sibling family — read from cache only; fetched on demand
                                  // when the operator actually clicks Split (startSplit).
                                  const siblings = item.productId
                                    ? siblingCache[item.productId]
                                    : undefined;
                                  // Auto-detected siblings (parent-tagged or name-prefix grouped).
                                  // null until fetched — the button falls back to generic wording.
                                  const autoDetectedCount = siblings ? siblings.length - 1 : null;
                                  const isLoadingSiblings = siblingLoadingId === item.productId;
                                  // Always offer the split affordance on a catalog-linked row —
                                  // even if no auto-siblings were detected, the operator can
                                  // open the panel and add varieties manually (e.g. when flavors
                                  // were entered as fully independent products with unrelated names).
                                  const canSplit = !!item.productId && !isSplit;
                                  const originalQty = parseFloat(item.qty) || 0;
                                  const sumMatchesOriginal =
                                    originalQty === 0 || Math.abs(splitTotal - originalQty) < 0.001;
                                  // unit is DERIVED from packSize > 1 — the Boxes/Pieces toggle
                                  // reads/writes packSize via toBillLine, never a separate field.
                                  const unit = unitOfItem(item);
                                  return (
                                    <React.Fragment key={i}>
                                      <tr className="group align-top transition-colors hover:bg-brand-50/30">
                                        <td className="px-3 py-3">
                                          <div className="space-y-1.5">
                                            {item.extractedName &&
                                              item.extractedName !== item.description && (
                                                <div className="flex items-start gap-1 text-[11px] text-navy/70">
                                                  <Sparkles className="mt-0.5 h-3 w-3 shrink-0 text-brand-400" />
                                                  <span
                                                    className="truncate"
                                                    title={item.extractedName}
                                                  >
                                                    {item.extractedName}
                                                  </span>
                                                </div>
                                              )}
                                            <div className="flex items-start gap-1.5">
                                              <SearchableProductPicker
                                                async
                                                value={item.productId}
                                                selectedLabel={
                                                  item.description ||
                                                  item.matchedProductName ||
                                                  undefined
                                                }
                                                onChange={(id, product) =>
                                                  handleProductSelect(i, id, product)
                                                }
                                                placeholder="Search products…"
                                                className="flex-1"
                                              />
                                              {!item.productId && (
                                                <button
                                                  type="button"
                                                  onClick={() => setCreateFromRow(i)}
                                                  disabled={isPending}
                                                  title="Add as new product"
                                                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-surface-border text-brand-600 transition-colors hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-40"
                                                >
                                                  <Plus className="h-3.5 w-3.5" />
                                                </button>
                                              )}
                                            </div>
                                            {!item.productId &&
                                              item.candidates &&
                                              item.candidates.length > 0 && (
                                                <div className="flex flex-wrap gap-1">
                                                  {item.candidates.slice(0, 3).map((c) => (
                                                    <button
                                                      key={c.productId}
                                                      type="button"
                                                      onClick={() =>
                                                        handleProductSelect(i, c.productId, {
                                                          id: c.productId,
                                                          name: c.name,
                                                          sku: c.sku ?? undefined,
                                                        })
                                                      }
                                                      className="inline-flex items-center rounded-full border border-brand-200 bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700 transition-colors hover:bg-brand-100"
                                                    >
                                                      Did you mean {c.name}? (
                                                      {Math.round(c.score * 100)}%)
                                                    </button>
                                                  ))}
                                                </div>
                                              )}
                                            {!item.productId && (
                                              <input
                                                type="text"
                                                value={item.description}
                                                onChange={(e) =>
                                                  updateItem(i, { description: e.target.value })
                                                }
                                                placeholder="Custom description (won't update stock)"
                                                className="w-full rounded-lg border border-surface-border px-2.5 py-1.5 text-sm text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-brand-500"
                                              />
                                            )}
                                          </div>
                                        </td>
                                        <td className="px-3 py-3">
                                          <ConfidenceBadge
                                            confidence={item.confidence}
                                            matchSource={item.matchSource}
                                          />
                                        </td>
                                        <td className="px-2 py-3">
                                          {isSplit ? (
                                            <div className="flex flex-col items-end gap-1">
                                              <div
                                                className={cn(
                                                  "rounded-lg border px-2 py-1.5 text-right text-sm font-semibold tabular-nums",
                                                  sumMatchesOriginal
                                                    ? "border-green-200 bg-green-50 text-green-700"
                                                    : "border-amber-200 bg-amber-50 text-amber-700",
                                                )}
                                                title={
                                                  sumMatchesOriginal
                                                    ? "Split totals match the extracted qty"
                                                    : `Split totals ${splitTotal} don't match the extracted qty ${originalQty}`
                                                }
                                              >
                                                {splitTotal} / {originalQty}
                                              </div>
                                              <span className="text-[10px] text-navy/70">
                                                across {item.splits!.length} flavors
                                              </span>
                                            </div>
                                          ) : (
                                            <>
                                              <input
                                                type="number"
                                                min="0.001"
                                                step="0.001"
                                                inputMode="decimal"
                                                value={item.qty}
                                                onChange={(e) =>
                                                  updateLineValue(i, { qty: e.target.value })
                                                }
                                                // appearance:textfield + spin-button overrides hide the native
                                                // up/down arrows that eat ~18px of input width in Chrome/Firefox
                                                className="w-full rounded-lg border border-surface-border px-2 py-1.5 text-right text-sm tabular-nums text-navy focus:outline-none focus:ring-2 focus:ring-brand-500 [appearance:textfield] [&::-webkit-inner-spin-button]:m-0 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:m-0 [&::-webkit-outer-spin-button]:appearance-none"
                                              />
                                              {qtyChanged && (
                                                <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-brand-500">
                                                  <Sparkles className="h-2.5 w-2.5" />
                                                  AI: {item.extractedQty}
                                                </div>
                                              )}
                                              {/* Boxes/Pieces toggle: unit is DERIVED from
                                                  packSize > 1. Replays the row's canonical
                                                  PieceSnapshot through toBillLine so switching
                                                  is lossless — a Boxes line posted without an
                                                  explicit packSize is the #335/#336 stock/AVCO
                                                  corruption class (A3). */}
                                              <div className="mt-1 flex flex-col items-end gap-1">
                                                <div className="flex items-center gap-1.5">
                                                  <div className="inline-flex overflow-hidden rounded border border-surface-border text-[10px] font-medium">
                                                    <button
                                                      type="button"
                                                      onClick={() => setLineUnit(i, "pieces")}
                                                      className={cn(
                                                        "px-1.5 py-0.5 transition-colors",
                                                        unit === "pieces"
                                                          ? "bg-brand-500 text-white"
                                                          : "text-navy/60 hover:bg-surface-raised",
                                                      )}
                                                    >
                                                      Pieces
                                                    </button>
                                                    <button
                                                      type="button"
                                                      onClick={() => setLineUnit(i, "boxes")}
                                                      className={cn(
                                                        "px-1.5 py-0.5 transition-colors",
                                                        unit === "boxes"
                                                          ? "bg-brand-500 text-white"
                                                          : "text-navy/60 hover:bg-surface-raised",
                                                      )}
                                                    >
                                                      Boxes
                                                    </button>
                                                  </div>
                                                  <div
                                                    className="flex items-center gap-1 text-[10px] text-navy/60"
                                                    title="Units per case — Boxes prices the CASE; receiving converts to pieces"
                                                  >
                                                    <span>×</span>
                                                    <input
                                                      type="number"
                                                      min="2"
                                                      step="1"
                                                      inputMode="numeric"
                                                      value={item.ppbDraft ?? ""}
                                                      placeholder="—"
                                                      onChange={(e) => {
                                                        const n = parseInt(e.target.value, 10);
                                                        setLinePpb(
                                                          i,
                                                          Number.isFinite(n) && n > 0 ? n : null,
                                                        );
                                                      }}
                                                      className="w-10 rounded border border-surface-border px-1 py-0.5 text-right text-[10px] tabular-nums text-navy placeholder:text-navy/30 focus:outline-none focus:ring-1 focus:ring-brand-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                                    />
                                                    <span>pcs</span>
                                                  </div>
                                                </div>
                                                {unit === "boxes" && item.preConvert && (
                                                  <span className="text-[10px] text-navy/50">
                                                    from {item.preConvert.qtyPieces} pcs @{" "}
                                                    {fmt(item.preConvert.costPerPiece)}
                                                  </span>
                                                )}
                                                {item.unitWarning === "NOT_DIVISIBLE" && (
                                                  <span
                                                    className="text-[10px] font-medium text-amber-600"
                                                    title="This piece count doesn't divide evenly into cases — kept as pieces so stock never drifts."
                                                  >
                                                    Not divisible — kept as pieces
                                                  </span>
                                                )}
                                                {item.unitWarning === "PPB_MISMATCH" && (
                                                  <span
                                                    className="text-[10px] font-medium text-amber-600"
                                                    title="The linked product's catalog case size differs from the case size on screen — the on-screen value is used."
                                                  >
                                                    Case size differs from catalog
                                                  </span>
                                                )}
                                              </div>
                                              {canSplit && (
                                                <button
                                                  type="button"
                                                  onClick={() => void startSplit(i)}
                                                  disabled={isLoadingSiblings}
                                                  className="mt-1 inline-flex items-center gap-1 rounded px-1 text-[10px] font-medium text-brand-600 transition-colors hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-50"
                                                  title={
                                                    autoDetectedCount == null
                                                      ? "Split this qty across multiple varieties"
                                                      : autoDetectedCount > 0
                                                        ? `Split this qty across ${autoDetectedCount} other variant${autoDetectedCount === 1 ? "" : "s"}`
                                                        : "Split this qty across multiple varieties — pick them manually"
                                                  }
                                                >
                                                  {isLoadingSiblings ? (
                                                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                                                  ) : (
                                                    <Layers className="h-2.5 w-2.5" />
                                                  )}
                                                  Split by variety
                                                  {autoDetectedCount != null &&
                                                    autoDetectedCount > 0 && (
                                                      <span className="text-navy/70">
                                                        ({autoDetectedCount + 1})
                                                      </span>
                                                    )}
                                                </button>
                                              )}
                                            </>
                                          )}
                                        </td>
                                        <td className="px-2 py-3">
                                          <div className="relative">
                                            <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-sm text-navy/70">
                                              $
                                            </span>
                                            <input
                                              type="number"
                                              min="0"
                                              step="0.0001"
                                              inputMode="decimal"
                                              value={item.unitCost}
                                              onChange={(e) =>
                                                updateLineValue(i, { unitCost: e.target.value })
                                              }
                                              className="w-full rounded-lg border border-surface-border py-1.5 pl-5 pr-2 text-right text-sm tabular-nums text-navy focus:outline-none focus:ring-2 focus:ring-brand-500 [appearance:textfield] [&::-webkit-inner-spin-button]:m-0 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:m-0 [&::-webkit-outer-spin-button]:appearance-none"
                                            />
                                          </div>
                                          {costChanged && (
                                            <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-brand-500">
                                              <Sparkles className="h-2.5 w-2.5" />
                                              AI: ${item.extractedUnitCost}
                                            </div>
                                          )}
                                          {(item.packSize ?? 0) > 1 && (
                                            <div className="mt-1 text-right text-[10px] text-navy/60">
                                              per case of {item.packSize}
                                            </div>
                                          )}
                                        </td>
                                        <td className="px-3 py-3 text-right text-sm font-medium tabular-nums text-navy">
                                          {invoiceTotal != null ? (
                                            <span
                                              className={cn(
                                                calculated != null &&
                                                  Math.abs(calculated - invoiceTotal) > 0.01
                                                  ? "text-amber-600"
                                                  : "text-navy",
                                              )}
                                              title={
                                                calculated != null &&
                                                Math.abs(calculated - invoiceTotal) > 0.01
                                                  ? `Calculated ${fmt(calculated)} differs from invoice total`
                                                  : undefined
                                              }
                                            >
                                              {fmt(invoiceTotal)}
                                            </span>
                                          ) : calculated != null ? (
                                            fmt(calculated)
                                          ) : (
                                            <span className="text-navy/30">—</span>
                                          )}
                                        </td>
                                        <td className="px-2 py-3 text-center">
                                          <button
                                            onClick={() => removeItem(i)}
                                            className="rounded-lg p-1.5 text-navy/30 opacity-0 transition-all group-hover:opacity-100 hover:bg-red-50 hover:text-red-500"
                                            title="Remove line"
                                          >
                                            <Trash2 className="h-4 w-4" />
                                          </button>
                                        </td>
                                      </tr>
                                      {isSplit && (
                                        <tr className="bg-brand-50/30">
                                          <td colSpan={6} className="px-3 py-3">
                                            <div className="rounded-lg border border-brand-200 bg-white p-3">
                                              <div className="mb-2 flex items-center justify-between gap-2">
                                                <div className="flex items-center gap-2 text-xs font-semibold text-navy">
                                                  <Layers className="h-3.5 w-3.5 text-brand-500" />
                                                  Split across {item.splits!.length} varieties
                                                  <span className="font-normal text-navy/70">
                                                    — same unit price ({fmt(cost)} ea)
                                                  </span>
                                                </div>
                                                <button
                                                  type="button"
                                                  onClick={() => cancelSplit(i)}
                                                  className="rounded px-2 py-0.5 text-[11px] font-medium text-navy/70 transition-colors hover:bg-surface-raised hover:text-navy"
                                                >
                                                  Cancel split
                                                </button>
                                              </div>
                                              <div className="grid gap-1.5">
                                                {item.splits!.map((split, j) => {
                                                  return (
                                                    <div
                                                      key={split.productId}
                                                      className="flex items-center gap-2 rounded border border-surface-border bg-surface-raised/40 px-2.5 py-1.5"
                                                    >
                                                      <span
                                                        className="flex-1 truncate text-xs text-navy"
                                                        title={split.name}
                                                      >
                                                        {split.variantName ??
                                                          split.name ??
                                                          "Unknown variant"}
                                                      </span>
                                                      <input
                                                        type="number"
                                                        min="0"
                                                        step="0.001"
                                                        inputMode="decimal"
                                                        value={split.qty}
                                                        onChange={(e) =>
                                                          updateSplitQty(i, j, e.target.value)
                                                        }
                                                        className="w-20 rounded border border-surface-border px-2 py-1 text-right text-xs tabular-nums text-navy focus:outline-none focus:ring-2 focus:ring-brand-500 [appearance:textfield] [&::-webkit-inner-spin-button]:m-0 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:m-0 [&::-webkit-outer-spin-button]:appearance-none"
                                                      />
                                                      <button
                                                        type="button"
                                                        onClick={() => removeSplit(i, j)}
                                                        disabled={item.splits!.length <= 1}
                                                        className="rounded p-0.5 text-navy/30 transition-colors hover:bg-red-50 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-navy/30"
                                                        title={
                                                          item.splits!.length <= 1
                                                            ? "Cancel split instead of removing the last variety"
                                                            : "Remove this variety from the split"
                                                        }
                                                      >
                                                        <X className="h-3 w-3" />
                                                      </button>
                                                    </div>
                                                  );
                                                })}
                                              </div>
                                              {/*
                                      Manual escape hatch: when flavors weren't tagged as
                                      variants in the catalog AND the name-prefix grouping
                                      didn't catch them, the operator can still add varieties
                                      one-by-one from the full product list.
                                    */}
                                              <div className="mt-2 flex items-center gap-2">
                                                <SearchableProductPicker
                                                  async
                                                  value=""
                                                  onChange={(id, product) => {
                                                    if (id) addSplitVariant(i, id, product);
                                                  }}
                                                  excludeIds={item.splits!.map((s) => s.productId)}
                                                  placeholder="+ Add another variety…"
                                                  className="flex-1"
                                                />
                                              </div>
                                              {!sumMatchesOriginal && (
                                                <p className="mt-2 flex items-start gap-1 text-[11px] text-amber-700">
                                                  <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                                                  Variety totals ({splitTotal}) don&apos;t match the
                                                  extracted qty ({originalQty}). You can still save
                                                  — totals will recompute from the splits.
                                                </p>
                                              )}
                                            </div>
                                          </td>
                                        </tr>
                                      )}
                                    </React.Fragment>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                          <button
                            onClick={addItem}
                            className="mt-2 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm font-medium text-brand-600 transition-colors hover:bg-brand-50"
                          >
                            + Add line item
                          </button>
                        </div>
                      )}

                      {/* Totals */}
                      <div className="flex justify-end">
                        <div className="min-w-[200px] rounded-lg border border-surface-border bg-surface-raised p-3 text-sm">
                          <div className="flex justify-between gap-8">
                            <span className="text-navy">Subtotal</span>
                            <span className="font-medium text-navy">
                              {fmt(
                                createMode === "expense" ? (scanResult?.total ?? 0) : computedTotal,
                              )}
                            </span>
                          </div>
                          {scanResult?.tax != null && scanResult.tax > 0 && (
                            <div className="mt-1 flex justify-between gap-8">
                              <span className="text-navy">Tax (added to amount owed)</span>
                              <span className="text-navy">{fmt(scanResult.tax)}</span>
                            </div>
                          )}
                          {scanResult?.total != null && (
                            <div className="mt-1 flex justify-between gap-8 border-t border-surface-border pt-1">
                              <span className="text-navy">Invoice Total</span>
                              <span className="font-semibold text-navy">
                                {fmt(scanResult.total)}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-surface-border px-6 py-4">
          {step === "review" ? (
            <>
              <button
                onClick={handleScanAgain}
                className="text-sm text-navy/70 transition-colors hover:text-navy"
              >
                ← Scan again
              </button>
              <div className="flex items-center gap-3">
                {invoices.length > 1 && creatable.length > 0 && (
                  <span className="text-xs tabular-nums text-navy/60">
                    Batch total {fmt(batchTotal)}
                  </span>
                )}
                <Button variant="secondary" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={() => void handleCreateAll()}
                  disabled={isPending || creatable.length === 0}
                >
                  {isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Creating...
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="h-4 w-4" />
                      {createLabel}
                    </>
                  )}
                </Button>
              </div>
            </>
          ) : (
            <Button variant="secondary" onClick={onClose} className="ml-auto">
              Cancel
            </Button>
          )}
        </div>
      </div>

      {/* Full product form (variants, regulated section/subcategory, description,
          costing, units/box, images) pre-filled from the unmatched extracted line:
          name + scanned SKU, sell price suggested at cost + 30% (editable), the
          invoice cost pre-filled as standardCost — finish setup later. */}
      {createFromRow != null && reviewItems[createFromRow] && (
        <ProductCreateModal
          isOpen
          onClose={() => setCreateFromRow(null)}
          initialName={
            reviewItems[createFromRow].extractedName || reviewItems[createFromRow].description
          }
          initialSku={reviewItems[createFromRow].sku ?? undefined}
          // Boxed contract asymmetry: pricePerUnit is the BOX price, but
          // standardCost is per PIECE (costPerSellingUnit multiplies back) —
          // so a case-priced line divides the cost prefill, not the price.
          initialPrice={
            parseFloat(reviewItems[createFromRow].unitCost) > 0
              ? roundMoney(parseFloat(reviewItems[createFromRow].unitCost) * 1.3)
              : undefined
          }
          initialCost={
            parseFloat(reviewItems[createFromRow].unitCost) > 0
              ? parseFloat(reviewItems[createFromRow].unitCost) /
                Math.max(1, reviewItems[createFromRow].packSize ?? 1)
              : undefined
          }
          initialUnitsPerBox={reviewItems[createFromRow].packSize ?? undefined}
          onCreated={(product) => {
            const i = createFromRow;
            const item = reviewItems[i];
            // Link the row directly — the fresh product isn't in the cached
            // catalog list yet, so handleProductSelect's lookup would miss it.
            updateItem(i, {
              productId: product.id,
              description: product.name,
              splits: undefined,
              matchSource: null,
              catalogUnitsPerBox:
                product.unitsPerBox && product.unitsPerBox > 1 ? product.unitsPerBox : null,
            });
            // Teach the matcher this supplier's wording for next time.
            const detectedSupplier = scanResult?.supplier;
            if (detectedSupplier && item.extractedName) {
              saveMapping.mutate({
                supplierName: detectedSupplier,
                rawDescription: item.extractedName,
                productId: product.id,
              });
            }
            setCreateFromRow(null);
          }}
        />
      )}
    </div>
  );
}

const STATUS_DOT: Record<InvoiceStatus, { cls: string; label: string }> = {
  scanning: { cls: "bg-navy/30 animate-pulse", label: "Scanning" },
  scanned: { cls: "bg-brand-500", label: "Ready to review" },
  failed: { cls: "bg-danger", label: "Scan failed" },
  created: { cls: "bg-success", label: "Created" },
  skipped: { cls: "bg-navy/20", label: "Skipped — already recorded" },
};

/**
 * Says what happened the last time these exact bytes were uploaded. Never a
 * failure: either the work is already done (a bill exists — open it instead of
 * paying twice in stock and cash), or an abandoned review just came back
 * whole, off the archive, with no second AI call.
 */
function PriorScanBanner({
  prior,
  disabled,
  onSkip,
}: {
  prior: PriorScanSummary;
  disabled?: boolean;
  /** Drop this pre-existing invoice from the batch — only offered when the
   *  prior scan was POSTED (the green "restored" variant isn't a duplicate). */
  onSkip?: () => void;
}) {
  const recorded = prior.status === "POSTED" && !!prior.vendorBillId;
  // fmtDate answers with an em-dash for anything unparseable; a missing
  // timestamp should drop the clause entirely rather than read "on —".
  const at = prior.scannedAt ? new Date(prior.scannedAt) : null;
  const when = at && !Number.isNaN(at.getTime()) ? fmtDate(prior.scannedAt) : null;
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border p-3",
        recorded ? "border-amber-200 bg-amber-50" : "border-green-200 bg-green-50",
      )}
      data-testid="prior-scan-banner"
    >
      {recorded ? (
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      ) : (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
      )}
      <div className="min-w-0 flex-1">
        <p className={cn("text-xs", recorded ? "text-amber-800" : "text-green-700")}>
          {recorded ? (
            <>
              <span className="font-semibold">
                You already scanned this — recorded as {prior.billNumber ?? "a vendor bill"}
                {when ? ` on ${when}` : ""}
                {prior.total != null ? `, ${fmt(prior.total)}` : ""}.
              </span>{" "}
              Open that bill instead of recording it a second time.
            </>
          ) : (
            <>
              <span className="font-semibold">
                Picking up where you left off — this document was scanned
                {when ? ` on ${when}` : " earlier"} and never finished.
              </span>{" "}
              Everything below is the saved extraction, restored without re-reading the invoice.
            </>
          )}
        </p>
        {recorded && prior.vendorBillId && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <a
              href={`/vendor-bills/${prior.vendorBillId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-surface-border bg-white px-2.5 py-1 text-xs font-medium text-navy transition-colors hover:border-brand-300 hover:text-brand-600"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open {prior.billNumber ?? "existing bill"}
            </a>
            {onSkip && (
              <button
                type="button"
                onClick={onSkip}
                disabled={disabled}
                data-testid="duplicate-skip"
                className="rounded-lg border border-surface-border bg-white px-2.5 py-1 text-xs font-medium text-navy transition-colors hover:border-brand-300 hover:text-brand-600 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Skip this invoice
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Warns that this supplier invoice is already in the system. Two shapes,
 * because the recovery differs: a DRAFT match is resumable (finish that bill),
 * an already-received match is not (a second one would double stock).
 */
function DuplicateBanner({
  duplicate,
  pending,
  allowDuplicate,
  disabled,
  onAllow,
  onUndo,
  onSkip,
}: {
  duplicate: DuplicateVendorBillInfo | null;
  pending: boolean;
  allowDuplicate: boolean;
  disabled?: boolean;
  onAllow: () => void;
  onUndo: () => void;
  /** Drop this pre-existing invoice from the batch (status → "skipped"). */
  onSkip: () => void;
}) {
  if (!duplicate) {
    return pending ? (
      <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-navy/60">
        <Loader2 className="h-3 w-3 animate-spin" />
        Checking whether this invoice is already recorded…
      </p>
    ) : null;
  }

  if (allowDuplicate) {
    return (
      <div
        className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-surface-border bg-white px-2.5 py-2"
        data-testid="duplicate-override"
      >
        <p className="text-xs text-navy/70">
          Recording a second bill anyway — {duplicate.billNumber} already exists.
        </p>
        <button
          type="button"
          onClick={onUndo}
          disabled={disabled}
          className="flex shrink-0 items-center gap-1 text-xs font-medium text-brand-600 transition-colors hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Undo2 className="h-3.5 w-3.5" />
          Undo
        </button>
      </div>
    );
  }

  const resumable = duplicate.resumable;
  const seenOn = duplicate.receivedDate ?? duplicate.billDate;
  return (
    <div
      className={cn(
        "mt-2 flex items-start gap-2 rounded-lg border p-2.5",
        resumable ? "border-amber-200 bg-amber-50" : "border-danger/30 bg-danger-bg",
      )}
      data-testid="duplicate-banner"
    >
      <AlertCircle
        className={cn("mt-0.5 h-4 w-4 shrink-0", resumable ? "text-amber-600" : "text-danger")}
      />
      <div className="min-w-0 flex-1">
        <p className={cn("text-xs", resumable ? "text-amber-800" : "text-danger")}>
          {resumable ? (
            <>
              <span className="font-semibold">
                A draft bill for this invoice already exists — {duplicate.billNumber},{" "}
                {fmt(duplicate.totalOwed)}.
              </span>{" "}
              Finish that one instead of creating a second bill.
            </>
          ) : (
            <>
              <span className="font-semibold">
                Already imported as {duplicate.billNumber}
                {seenOn ? ` on ${fmtCalendarDate(seenOn)}` : ""}.
              </span>{" "}
              Creating it again would double stock and the amount owed.
            </>
          )}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <a
            href={`/vendor-bills/${duplicate.billId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 rounded-lg border border-surface-border bg-white px-2.5 py-1 text-xs font-medium text-navy transition-colors hover:border-brand-300 hover:text-brand-600"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            View existing bill
          </a>
          <button
            type="button"
            onClick={onSkip}
            disabled={disabled}
            data-testid="duplicate-skip"
            className="rounded-lg border border-surface-border bg-white px-2.5 py-1 text-xs font-medium text-navy transition-colors hover:border-brand-300 hover:text-brand-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Skip this invoice
          </button>
          <button
            type="button"
            onClick={onAllow}
            disabled={disabled}
            className="rounded-lg border border-surface-border bg-white px-2.5 py-1 text-xs font-medium text-navy transition-colors hover:border-brand-300 hover:text-brand-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Create anyway
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Batch navigator: prominent ◀ ▶ buttons to move between the scanned
 * invoices (one per PDF). Switching moves BOTH the preview panel and the
 * whole review form. Status dots jump straight to an invoice.
 */
function InvoiceNavigator({
  invoices,
  activeIndex,
  disabled,
  onNavigate,
  skippableDupCount = 0,
  onSkipAll,
}: {
  invoices: InvoiceGroup[];
  activeIndex: number;
  disabled?: boolean;
  onNavigate: (index: number) => void;
  /** Reviewable invoices currently matching something already in the system. */
  skippableDupCount?: number;
  /** Batch affordance: drop them all without paging through each one. */
  onSkipAll?: () => void;
}) {
  const active = invoices[activeIndex];
  const label = active
    ? (active.scanResult?.supplier ??
      (active.status === "scanning"
        ? "Scanning…"
        : active.status === "failed"
          ? "Scan failed"
          : (active.pagePreviews[0]?.name ?? "Invoice")))
    : "";
  // Same supplier invoice # appearing twice in one batch = likely the same
  // document uploaded twice.
  const norm = (n: string) => n.toUpperCase().replace(/\s+/g, "");
  const numberCounts = new Map<string, number>();
  for (const inv of invoices) {
    if (!inv.invoiceNumber) continue;
    const key = norm(inv.invoiceNumber);
    numberCounts.set(key, (numberCounts.get(key) ?? 0) + 1);
  }
  const isDuplicate =
    !!active?.invoiceNumber && (numberCounts.get(norm(active.invoiceNumber)) ?? 0) > 1;
  // Cross-session duplicate: matched against a bill recorded before this batch.
  const existingBill =
    active && active.createMode !== "expense" && !active.allowDuplicate ? active.duplicate : null;
  // Byte-identical to a document already in the archive. Suppressed when the
  // duplicate marker is already saying the same thing about the same bill.
  const prior = existingBill ? null : (active?.scanResult?.priorScan ?? null);
  const priorRecorded = !!prior && prior.status === "POSTED" && !!prior.vendorBillId;

  return (
    <div className="flex items-center gap-3 border-b border-surface-border bg-surface-raised px-4 py-2">
      <button
        type="button"
        onClick={() => onNavigate(activeIndex - 1)}
        disabled={disabled || activeIndex === 0}
        className="flex items-center gap-1 rounded-lg border border-surface-border bg-white px-3 py-1.5 text-sm font-semibold text-navy transition-colors hover:border-brand-300 hover:text-brand-600 disabled:cursor-not-allowed disabled:opacity-30"
        title="Previous invoice"
        data-testid="invoice-nav-prev"
      >
        <ChevronLeft className="h-4 w-4" />
        Prev
      </button>
      <div className="min-w-0 flex-1 text-center">
        <p className="text-xs font-semibold text-navy">
          Invoice {activeIndex + 1} of {invoices.length}
          {active?.invoiceNumber ? ` · #${active.invoiceNumber}` : ""}
        </p>
        <p className="truncate text-[11px] text-navy/60" title={label}>
          {label}
          {/* "Skipped" outranks every other marker — the decision is made. */}
          {active?.status === "skipped" ? (
            <span className="font-medium text-navy/50"> — skipped (already recorded)</span>
          ) : (
            <>
              {isDuplicate && (
                <span className="font-medium text-amber-600">
                  {" "}
                  — same invoice # as another file in this batch
                </span>
              )}
              {existingBill && (
                <span
                  className={cn(
                    "font-medium",
                    existingBill.resumable ? "text-amber-600" : "text-danger",
                  )}
                >
                  {" "}
                  — already {existingBill.resumable ? "saved as draft" : "imported as"}{" "}
                  {existingBill.billNumber}
                </span>
              )}
              {prior && (
                <span
                  className={cn("font-medium", priorRecorded ? "text-amber-600" : "text-green-700")}
                >
                  {" "}
                  —{" "}
                  {priorRecorded
                    ? `already recorded as ${prior.billNumber ?? "a bill"}`
                    : "restored from an earlier scan"}
                </span>
              )}
            </>
          )}
        </p>
        {skippableDupCount > 1 && onSkipAll && (
          <button
            type="button"
            onClick={onSkipAll}
            disabled={disabled}
            data-testid="skip-all-duplicates"
            className="mt-0.5 text-[11px] font-medium text-brand-600 transition-colors hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {skippableDupCount} already recorded · Skip them
          </button>
        )}
        <div className="mt-1 flex items-center justify-center gap-1.5">
          {invoices.map((inv, i) => (
            <button
              key={inv.id}
              type="button"
              onClick={() => onNavigate(i)}
              disabled={disabled}
              className={cn(
                "h-2.5 w-2.5 rounded-full transition-all disabled:cursor-not-allowed disabled:opacity-40",
                STATUS_DOT[inv.status].cls,
                i === activeIndex && "ring-2 ring-brand-300 ring-offset-1",
              )}
              title={`Invoice ${i + 1}: ${STATUS_DOT[inv.status].label}`}
            />
          ))}
        </div>
      </div>
      <button
        type="button"
        onClick={() => onNavigate(activeIndex + 1)}
        disabled={disabled || activeIndex === invoices.length - 1}
        className="flex items-center gap-1 rounded-lg border border-surface-border bg-white px-3 py-1.5 text-sm font-semibold text-navy transition-colors hover:border-brand-300 hover:text-brand-600 disabled:cursor-not-allowed disabled:opacity-30"
        title="Next invoice"
        data-testid="invoice-nav-next"
      >
        Next
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}
