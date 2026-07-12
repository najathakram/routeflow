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
} from "lucide-react";
import { Button, useToast, cn } from "@routeflow/ui/web";
import { scanInvoice, type ScannedItem, type ScanResult } from "@/lib/api/invoice-scan";
import { useSuppliers } from "@/lib/api/inventory";
import { useProducts } from "@/lib/api/products";
import {
  useCreateVendorBill,
  useReceiveVendorBill,
  useSaveProductMapping,
} from "@/lib/api/vendor-bills";
import { useCreateExpense, useExpenseCategories } from "@/lib/api/finance";
import { SupplierSelect } from "./SupplierSelect";
import { InlineCreateProductModal } from "./InlineCreateProductModal";
import { displayProductName } from "@/lib/product-display";
import { roundMoney } from "@/lib/pricing";

const fmt = (n: number | null | undefined) =>
  n != null
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n)
    : "—";

type CreateMode = "bill" | "expense" | "both";

interface VarietySplit {
  productId: string;
  qty: string;
}

interface ReviewItem {
  extractedName: string;
  productId: string;
  description: string;
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

type InvoiceStatus = "scanning" | "scanned" | "failed" | "created";

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
  scanResult: ScanResult | null;
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

const MAX_FILE_BYTES = 25 * 1024 * 1024; // server-side Multer per-file cap
const MAX_PAGES_PER_INVOICE = 10; // server-side FilesInterceptor cap per scan call
const MAX_INVOICES_PER_BATCH = 10; // bounds Claude spend per batch

function ConfidenceBadge({ confidence }: { confidence: ScannedItem["confidence"] }) {
  const styles: Record<ScannedItem["confidence"], string> = {
    high: "bg-green-100 text-green-700",
    medium: "bg-yellow-100 text-yellow-700",
    low: "bg-orange-100 text-orange-700",
    none: "bg-gray-100 text-gray-600",
  };
  const labels: Record<ScannedItem["confidence"], string> = {
    high: "High match",
    medium: "Possible match",
    low: "Weak match",
    none: "No match",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
        styles[confidence],
      )}
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
  const setSupplierId = (v: string) =>
    updateActive({ supplierId: v, supplierMatchAmbiguous: false });
  const billDate = active?.billDate ?? new Date().toISOString().slice(0, 10);
  const setBillDate = (v: string) => updateActive({ billDate: v });
  const dueDate = active?.dueDate ?? "";
  const setDueDate = (v: string) => updateActive({ dueDate: v });
  const invoiceNumber = active?.invoiceNumber ?? "";
  const setInvoiceNumber = (v: string) => updateActive({ invoiceNumber: v });

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

  const { data: productsData } = useProducts({ limit: 1000 });
  const products =
    (
      productsData as
        | {
            data: {
              id: string;
              name: string;
              unit: string;
              averageCost?: string;
              parentProductId?: string | null;
              variantName?: string | null;
            }[];
          }
        | undefined
    )?.data ?? [];

  /**
   * Given the productId of a matched row, return the full set of likely
   * sibling products so the operator can split one invoice line across
   * flavors / varieties. Two discovery paths, deduped by id:
   *
   *   1. Parent-tagged variants — products that share `parentProductId`
   *      (the "correct" model). Includes the case where the matched
   *      product itself IS a parent and has children.
   *
   *   2. Name-prefix grouping — for catalogs where flavors were entered
   *      as independent products (no parentProductId). We split the
   *      matched product's name on common separators (" - ", " — ",
   *      ": ") and find every other product whose name starts with the
   *      same "<base> <separator>" prefix. This means the operator can
   *      use the split feature without first reorganising their catalog.
   *
   * Returns the matched product first (so it pre-selects naturally),
   * then everything else sorted by display label.
   */
  const getVariantSiblings = React.useCallback(
    (productId: string) => {
      const matched = products.find((p) => p.id === productId);
      if (!matched) return [] as typeof products;

      // Path 1 — proper parent-tagged variants
      const parentId = matched.parentProductId ?? matched.id;
      const parentSiblings = products
        .filter((p) => (p.parentProductId ?? p.id) === parentId)
        .filter((p) => p.id !== parentId || p.parentProductId === parentId);

      // Path 2 — name-prefix grouping (catches flavors stored as standalone products).
      // Tries " - ", " — ", and ": " in that order; uses whichever appears in the name.
      const SEPARATORS = [" - ", " — ", ": "];
      const sep = SEPARATORS.find((s) => matched.name.includes(s));
      let prefixSiblings: typeof products = [];
      if (sep) {
        const prefix = matched.name.split(sep).slice(0, -1).join(sep).trim();
        // Require ≥3 chars to avoid grouping on tokens like "A" / "S".
        if (prefix.length >= 3) {
          const needle = `${prefix}${sep}`.toLowerCase();
          prefixSiblings = products.filter((p) => p.name.toLowerCase().startsWith(needle));
        }
      }

      // Merge + dedupe by id; keep the matched product first.
      const seen = new Set<string>();
      const merged: typeof products = [];
      for (const p of [matched, ...parentSiblings, ...prefixSiblings]) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        merged.push(p);
      }
      return merged.sort((a, b) => {
        if (a.id === productId) return -1;
        if (b.id === productId) return 1;
        return (a.variantName ?? a.name).localeCompare(b.variantName ?? b.name);
      });
    },
    [products],
  );

  const { data: expenseCategories } = useExpenseCategories();
  const categories = expenseCategories ?? [];

  const createBill = useCreateVendorBill();
  const receiveBill = useReceiveVendorBill();
  const createExpense = useCreateExpense();
  const saveMapping = useSaveProductMapping();

  // Abort in-flight scans, revoke every live object URL, drop all invoices.
  const discardSession = () => {
    runIdRef.current++;
    abortersRef.current.forEach((c) => c.abort());
    abortersRef.current.clear();
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
  React.useEffect(
    () => () => {
      abortersRef.current.forEach((c) => c.abort());
      invoicesRef.current.forEach((inv) =>
        inv.pagePreviews.forEach((p) => URL.revokeObjectURL(p.url)),
      );
    },
    [],
  );

  /** Seed an invoice's review state from its scan result. */
  const applyScan = (id: string, result: ScanResult) => {
    const items: ReviewItem[] = (result.items ?? []).map((item) => ({
      extractedName: item.extractedName,
      productId: item.matchedProductId ?? "",
      description: item.matchedProductName ?? item.extractedName,
      qty: String(item.qty ?? 1),
      unitCost: String(item.unitCost ?? ""),
      lineTotal: item.lineTotal ?? null,
      extractedQty: String(item.qty ?? 1),
      extractedUnitCost: String(item.unitCost ?? ""),
      confidence: item.confidence,
    }));
    const patch: Partial<InvoiceGroup> = {
      status: "scanned",
      error: null,
      scanResult: result,
      reviewItems: items.length > 0 ? items : [emptyReviewItem()],
      invoiceNumber: result.invoiceNumber ?? "",
    };
    if (result.supplier) {
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
    patchInvoiceById(id, patch);
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
      const result = await scanInvoice(inv.files, controller.signal);
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

  const handleProductSelect = (i: number, productId: string) => {
    const product = products.find((p) => p.id === productId);
    const item = reviewItems[i];
    if (product) {
      // Only update the product link + description.
      // Keep the invoice-extracted price — that is what the supplier is actually charging.
      // The product's averageCost is our historical average, not the current invoice price.
      updateItem(i, {
        productId,
        // Compose "<Parent> - <Variant>" so the bill line reads
        // meaningfully on its own (variants store just the variant
        // name in `product.name` per PR #44).
        description: displayProductName(product, products),
        // unitCost intentionally NOT overwritten — preserve the extracted invoice price
        // Changing the matched product invalidates any in-progress split.
        splits: undefined,
      });
    } else {
      updateItem(i, {
        productId: "",
        description: item.extractedName,
        splits: undefined,
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
   * the rows whose qty actually changed.
   */
  const startSplit = (i: number) => {
    const item = reviewItems[i];
    if (!item.productId) return;
    const siblings = getVariantSiblings(item.productId);
    if (siblings.length === 0) return;
    const splits: VarietySplit[] = siblings.map((s) => ({
      productId: s.id,
      qty: s.id === item.productId ? item.qty : "0",
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
   * the name-prefix grouping). Skips no-ops and duplicates.
   */
  const addSplitVariant = (rowIdx: number, productId: string) => {
    if (!productId) return;
    setReviewItems((prev) =>
      prev.map((row, idx) => {
        if (idx !== rowIdx) return row;
        const splits = row.splits ?? [];
        if (splits.some((s) => s.productId === productId)) return row;
        return { ...row, splits: [...splits, { productId, qty: "0" }] };
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

  // Money discipline: round every line and the sum (these feed the expense
  // amount, a monetary write).
  const invoiceTotalOf = (inv: InvoiceGroup) =>
    roundMoney(
      inv.reviewItems.reduce((s, item) => {
        const cost = parseFloat(item.unitCost) || 0;
        const qty =
          item.splits && item.splits.length > 0 ? splitSum(item.splits) : parseFloat(item.qty) || 0;
        return s + roundMoney(qty * cost);
      }, 0),
    );

  const computedTotal = active ? invoiceTotalOf(active) : 0;

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
  // Split entries inherit the row's unitCost (same SKU family on the invoice).
  const buildBillItems = (inv: InvoiceGroup) =>
    validItemsOf(inv).flatMap((item) => {
      if (item.splits && item.splits.length > 0) {
        return item.splits
          .filter((s) => parseFloat(s.qty) > 0)
          .map((s) => {
            const variant = products.find((p) => p.id === s.productId);
            return {
              productId: s.productId,
              description: variant?.name ?? item.description,
              qty: parseFloat(s.qty) || 0,
              unitCost: parseFloat(item.unitCost) || 0,
            };
          });
      }
      return [
        {
          productId: item.productId || undefined,
          description: item.description,
          qty: parseFloat(item.qty) || 1,
          unitCost: parseFloat(item.unitCost) || 0,
        },
      ];
    });

  /**
   * Post one invoice: create bill → receive → (expense), each step guarded by
   * an idempotency flag so a retried Create never re-posts what already
   * succeeded (a "both"-mode expense failure must not duplicate the bill).
   * Reads the invoice fresh from invoicesRef so retries see prior progress.
   */
  const createOne = async (invoiceId: string): Promise<{ ok: boolean; notes: string[] }> => {
    const inv = invoicesRef.current.find((x) => x.id === invoiceId);
    if (!inv) return { ok: false, notes: [] };
    const wantsBill = inv.createMode === "bill" || inv.createMode === "both";
    const wantsExpense = inv.createMode === "expense" || inv.createMode === "both";
    const notes: string[] = [];

    try {
      let billId = inv.createdBillId;
      if (wantsBill && !billId) {
        const billItems = buildBillItems(inv);
        const bill = await createBill.mutateAsync({
          supplierId: inv.supplierId,
          billDate: inv.billDate,
          dueDate: inv.dueDate || "",
          items: billItems,
          // Persist the supplier's own invoice number — it's how the operator
          // reconciles against the supplier statement later.
          notes: inv.invoiceNumber ? `Supplier invoice #${inv.invoiceNumber}` : undefined,
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
        const expenseTotal = wantsBill
          ? invoiceTotalOf(inv)
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
      return { ok: true, notes };
    } catch (err: any) {
      const msg =
        err?.response?.data?.message ||
        err?.message ||
        "Failed to create records. Please try again.";
      // Keep status "scanned" so the invoice stays editable + creatable.
      patchInvoiceById(invoiceId, { error: msg });
      return { ok: false, notes };
    }
  };

  const handleCreateAll = async () => {
    const targets = invoices
      .map((inv, index) => ({ inv, index }))
      .filter(({ inv }) => inv.status === "scanned");
    if (targets.length === 0 || isSubmittingAll) return;

    // Pre-validate everything up front: nothing posts until every target is valid.
    for (const { inv, index } of targets) {
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
    const unlinked = targets
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
      const allNotes: string[] = [];
      for (const { inv } of targets) {
        const { ok, notes } = await createOne(inv.id);
        if (ok) created++;
        else failed++;
        allNotes.push(...notes);
      }
      // Invoices that couldn't be posted this pass (scan failed / still scanning)
      // must not vanish with the modal — keep it open so they can be retried.
      const leftBehind = invoicesRef.current.filter(
        (x) => x.status === "failed" || x.status === "scanning",
      ).length;
      if (failed === 0 && leftBehind === 0) {
        toast({
          title:
            targets.length === 1
              ? allNotes.join(" & ") + " successfully!"
              : `Created ${created} invoice${created === 1 ? "" : "s"} successfully!`,
          description: targets.length > 1 ? allNotes.join(" · ") : undefined,
          variant: "success",
        });
        onCreated?.();
        onClose();
      } else if (failed === 0) {
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
        // Keep the modal open: failed invoices stay editable, succeeded ones
        // are marked created and will be skipped on the next attempt.
        const firstFailed = invoicesRef.current.findIndex((x) => x.status === "scanned");
        if (firstFailed >= 0) {
          setActiveIndex(firstFailed);
          setCreateFromRow(null);
        }
        toast({
          title: `Created ${created} of ${targets.length} — ${failed} failed`,
          description:
            "Fix the failed invoices and click Create again. Already-created bills won't be duplicated.",
          variant: created > 0 ? "warning" : "error",
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
                              <option value="CASH">Cash</option>
                              <option value="CHECK">Check</option>
                              <option value="ACH">Bank Transfer</option>
                              <option value="CREDIT_CARD">Credit Card</option>
                              <option value="OTHER">Other</option>
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
                                  // Sibling variants exist only for catalog-linked items.
                                  const siblings = item.productId
                                    ? getVariantSiblings(item.productId)
                                    : [];
                                  // Auto-detected siblings (parent-tagged or name-prefix grouped).
                                  const autoDetectedCount = siblings.length - 1;
                                  // Always offer the split affordance on a catalog-linked row —
                                  // even if no auto-siblings were detected, the operator can
                                  // open the panel and add varieties manually (e.g. when flavors
                                  // were entered as fully independent products with unrelated names).
                                  const canSplit = !!item.productId && !isSplit;
                                  const originalQty = parseFloat(item.qty) || 0;
                                  const sumMatchesOriginal =
                                    originalQty === 0 || Math.abs(splitTotal - originalQty) < 0.001;
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
                                            <select
                                              value={item.productId}
                                              onChange={(e) =>
                                                handleProductSelect(i, e.target.value)
                                              }
                                              className="w-full rounded-lg border border-surface-border bg-white px-2.5 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                                            >
                                              <option value="">
                                                — Custom item (no inventory link) —
                                              </option>
                                              {item.productId &&
                                                !products.find((p) => p.id === item.productId) && (
                                                  <option value={item.productId}>
                                                    {item.description}
                                                  </option>
                                                )}
                                              {products.map((p) => (
                                                <option key={p.id} value={p.id}>
                                                  {p.name}
                                                </option>
                                              ))}
                                            </select>
                                            {!item.productId && (
                                              <>
                                                <input
                                                  type="text"
                                                  value={item.description}
                                                  onChange={(e) =>
                                                    updateItem(i, { description: e.target.value })
                                                  }
                                                  placeholder="Custom description (won't update stock)"
                                                  className="w-full rounded-lg border border-surface-border px-2.5 py-1.5 text-sm text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-brand-500"
                                                />
                                                <button
                                                  type="button"
                                                  onClick={() => setCreateFromRow(i)}
                                                  disabled={isPending}
                                                  className="flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700 hover:underline disabled:cursor-not-allowed disabled:opacity-40 disabled:no-underline"
                                                >
                                                  <Plus className="h-3 w-3" />
                                                  Create product from this line
                                                </button>
                                              </>
                                            )}
                                          </div>
                                        </td>
                                        <td className="px-3 py-3">
                                          <ConfidenceBadge confidence={item.confidence} />
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
                                                  updateItem(i, { qty: e.target.value })
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
                                              {canSplit && (
                                                <button
                                                  type="button"
                                                  onClick={() => startSplit(i)}
                                                  className="mt-1 inline-flex items-center gap-1 rounded px-1 text-[10px] font-medium text-brand-600 transition-colors hover:bg-brand-50"
                                                  title={
                                                    autoDetectedCount > 0
                                                      ? `Split this qty across ${autoDetectedCount} other variant${autoDetectedCount === 1 ? "" : "s"}`
                                                      : "Split this qty across multiple varieties — pick them manually"
                                                  }
                                                >
                                                  <Layers className="h-2.5 w-2.5" />
                                                  Split by variety
                                                  {autoDetectedCount > 0 && (
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
                                                updateItem(i, { unitCost: e.target.value })
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
                                                  const variantProduct = products.find(
                                                    (p) => p.id === split.productId,
                                                  );
                                                  return (
                                                    <div
                                                      key={split.productId}
                                                      className="flex items-center gap-2 rounded border border-surface-border bg-surface-raised/40 px-2.5 py-1.5"
                                                    >
                                                      <span
                                                        className="flex-1 truncate text-xs text-navy"
                                                        title={variantProduct?.name}
                                                      >
                                                        {variantProduct?.variantName ??
                                                          variantProduct?.name ??
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
                                                <select
                                                  value=""
                                                  onChange={(e) => {
                                                    if (e.target.value) {
                                                      addSplitVariant(i, e.target.value);
                                                      // Reset back to the placeholder option so the
                                                      // operator can pick another product right after.
                                                      e.target.value = "";
                                                    }
                                                  }}
                                                  className="flex-1 rounded border border-dashed border-brand-300 bg-white px-2.5 py-1.5 text-xs text-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
                                                >
                                                  <option value="">+ Add another variety…</option>
                                                  {products
                                                    .filter(
                                                      (p) =>
                                                        !item.splits!.some(
                                                          (s) => s.productId === p.id,
                                                        ),
                                                    )
                                                    .map((p) => (
                                                      <option key={p.id} value={p.id}>
                                                        {p.name}
                                                      </option>
                                                    ))}
                                                </select>
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
                              <span className="text-navy">Tax (detected)</span>
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

      {/* Quick-create a product from an unmatched extracted line: name pre-filled
          from the invoice text, sell price suggested at cost + 30% (editable),
          the invoice cost saved as standardCost — finish setup later. */}
      {createFromRow != null && reviewItems[createFromRow] && (
        <InlineCreateProductModal
          isOpen
          onClose={() => setCreateFromRow(null)}
          initialName={
            reviewItems[createFromRow].extractedName || reviewItems[createFromRow].description
          }
          initialPrice={
            parseFloat(reviewItems[createFromRow].unitCost) > 0
              ? roundMoney(parseFloat(reviewItems[createFromRow].unitCost) * 1.3)
              : undefined
          }
          initialCost={parseFloat(reviewItems[createFromRow].unitCost) || undefined}
          onCreated={(product) => {
            const i = createFromRow;
            const item = reviewItems[i];
            // Link the row directly — the fresh product isn't in the cached
            // catalog list yet, so handleProductSelect's lookup would miss it.
            updateItem(i, {
              productId: product.id,
              description: product.name,
              splits: undefined,
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
};

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
}: {
  invoices: InvoiceGroup[];
  activeIndex: number;
  disabled?: boolean;
  onNavigate: (index: number) => void;
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
          {isDuplicate && (
            <span className="font-medium text-amber-600">
              {" "}
              — same invoice # as another file in this batch
            </span>
          )}
        </p>
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
