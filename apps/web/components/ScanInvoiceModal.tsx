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
} from "lucide-react";
import { Button, useToast, cn } from "@routeflow/ui/web";
import { scanInvoice, type ScannedItem, type ScanResult } from "@/lib/api/invoice-scan";
import { useSuppliers } from "@/lib/api/inventory";
import { useProducts } from "@/lib/api/products";
import { useCreateVendorBill, useReceiveVendorBill, useSaveProductMapping } from "@/lib/api/vendor-bills";
import { useCreateExpense, useExpenseCategories } from "@/lib/api/finance";

const fmt = (n: number | null | undefined) =>
  n != null
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n)
    : "—";

type CreateMode = "bill" | "expense" | "both";

interface ReviewItem {
  extractedName: string;
  productId: string;
  description: string;
  qty: string;
  unitCost: string;
  lineTotal: number | null;      // raw AI-extracted line total (read-only reference)
  extractedQty: string;          // original AI-extracted qty (for hint display)
  extractedUnitCost: string;     // original AI-extracted unit cost (for hint display)
  confidence: ScannedItem["confidence"];
}

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
  const [scanResult, setScanResult] = React.useState<ScanResult | null>(null);
  const [reviewItems, setReviewItems] = React.useState<ReviewItem[]>([]);
  const [createMode, setCreateMode] = React.useState<CreateMode>("bill");
  const [isDragging, setIsDragging] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  // Multi-page support: an invoice can be one PDF, one image, or N image pages.
  // `pagePreviews` holds an object-URL per uploaded file so the user can flip
  // through them. `previewIndex` is the page currently displayed in the side panel.
  const [pagePreviews, setPagePreviews] = React.useState<
    Array<{ url: string; type: "pdf" | "image"; name: string }>
  >([]);
  const [previewIndex, setPreviewIndex] = React.useState(0);
  // Convenience accessors used throughout the JSX below
  const previewUrl = pagePreviews[previewIndex]?.url ?? null;
  const previewType = pagePreviews[previewIndex]?.type ?? null;
  const [showPreview, setShowPreview] = React.useState(true);

  // Bill fields
  const [supplierId, setSupplierId] = React.useState("");
  const [billDate, setBillDate] = React.useState(new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = React.useState("");

  // Expense fields
  const [expenseCategoryId, setExpenseCategoryId] = React.useState("");
  const [expenseDescription, setExpenseDescription] = React.useState("");
  const [expenseDate, setExpenseDate] = React.useState(new Date().toISOString().slice(0, 10));
  const [expensePaymentMethod, setExpensePaymentMethod] = React.useState("CASH");
  const [expenseNotes, setExpenseNotes] = React.useState("");

  const { data: suppliersData } = useSuppliers();
  const suppliers = (suppliersData as { id: string; name: string }[] | undefined) ?? [];

  const { data: productsData } = useProducts({ limit: 1000 });
  const products =
    (productsData as { data: { id: string; name: string; unit: string; averageCost?: string }[] } | undefined)
      ?.data ?? [];

  const { data: expenseCategories } = useExpenseCategories();
  const categories = expenseCategories ?? [];

  const createBill = useCreateVendorBill();
  const receiveBill = useReceiveVendorBill();
  const createExpense = useCreateExpense();
  const saveMapping = useSaveProductMapping();

  // Reset when opened
  React.useEffect(() => {
    if (open) {
      setStep("upload");
      setScanResult(null);
      setReviewItems([]);
      setCreateMode("bill");
      setSupplierId("");
      setBillDate(new Date().toISOString().slice(0, 10));
      setDueDate("");
      setExpenseCategoryId("");
      setExpenseDescription("");
      setExpenseDate(new Date().toISOString().slice(0, 10));
      setExpensePaymentMethod("CASH");
      setExpenseNotes("");
      // Revoke any previously created object URLs to avoid memory leaks
      pagePreviews.forEach((p) => URL.revokeObjectURL(p.url));
      setPagePreviews([]);
      setPreviewIndex(0);
      setShowPreview(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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
    if (normalised.length > 10) {
      toast({
        title: "Too many pages",
        description: "Up to 10 pages per invoice. Split larger documents.",
        variant: "error",
      });
      return;
    }
    // Build previews for the side panel. HEIC won't render in <img> on
    // most browsers, so we show a placeholder card for those pages.
    const previews = normalised.map((f) => ({
      url: URL.createObjectURL(f),
      type: f.type === "application/pdf" ? ("pdf" as const) : ("image" as const),
      name: f.name,
    }));
    setPagePreviews(previews);
    setPreviewIndex(0);
    setStep("processing");
    try {
      const result = await scanInvoice(normalised);
      setScanResult(result);
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
      setReviewItems(
        items.length > 0
          ? items
          : [{ extractedName: "", productId: "", description: "", qty: "1", unitCost: "", confidence: "none" as const, lineTotal: null, extractedQty: "1", extractedUnitCost: "" }],
      );
      // Pre-fill supplier
      if (result.supplier) {
        const match = suppliers.find((s) =>
          s.name.toLowerCase().includes(result.supplier!.toLowerCase()),
        );
        if (match) setSupplierId(match.id);
      }
      if (result.invoiceDate) {
        setBillDate(result.invoiceDate);
        setExpenseDate(result.invoiceDate);
      }
      // Pre-fill expense fields from AI extraction
      if (result.expenseDescription) setExpenseDescription(result.expenseDescription);
      if (result.expenseCategory) {
        // Try to match to an existing category
        const catMatch = categories.find(
          (c) => c.name.toLowerCase().includes(result.expenseCategory!.toLowerCase()) ||
                 result.expenseCategory!.toLowerCase().includes(c.name.toLowerCase()),
        );
        if (catMatch) setExpenseCategoryId(catMatch.id);
      }
      setStep("review");
      setShowPreview(true);
    } catch (err: any) {
      console.error(err);
      const msg = err?.response?.data?.message ?? "";
      const isApiKeyError = msg.toLowerCase().includes("api key") || msg.toLowerCase().includes("anthropic");
      toast({
        title: isApiKeyError
          ? "Anthropic API key not configured"
          : "Failed to scan invoice",
        description: isApiKeyError
          ? "Go to Settings → AI & Integrations to add your Claude API key."
          : "Please check the file and try again.",
        variant: "error",
      });
      setStep("upload");
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
      { extractedName: "", productId: "", description: "", qty: "1", unitCost: "", lineTotal: null, extractedQty: "1", extractedUnitCost: "", confidence: "none" },
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
        description: product.name,
        // unitCost intentionally NOT overwritten — preserve the extracted invoice price
      });
    } else {
      updateItem(i, { productId: "", description: item.extractedName });
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

  const computedTotal = reviewItems.reduce(
    (s, item) => s + (parseFloat(item.qty) || 0) * (parseFloat(item.unitCost) || 0),
    0,
  );

  const handleCreate = async () => {
    const validItems = reviewItems.filter(
      (item) => item.description && parseFloat(item.qty) > 0,
    );

    const createVendorBill = createMode === "bill" || createMode === "both";
    const createExpenseRecord = createMode === "expense" || createMode === "both";

    if (createVendorBill && !supplierId) {
      toast({ title: "Please select a supplier before creating the bill.", variant: "error" });
      return;
    }
    if (createVendorBill && validItems.length === 0) {
      toast({ title: "Add at least one valid line item for the vendor bill", variant: "error" });
      return;
    }
    if (createExpenseRecord && !expenseCategoryId) {
      toast({ title: "Select an expense category", variant: "error" });
      return;
    }

    try {
      const results: string[] = [];

      if (createVendorBill) {
        const bill = await createBill.mutateAsync({
          supplierId,
          billDate,
          dueDate: dueDate || "",
          items: validItems.map((item) => ({
            productId: item.productId || undefined,
            description: item.description,
            qty: parseFloat(item.qty) || 1,
            unitCost: parseFloat(item.unitCost) || 0,
          })),
        });
        // Auto-receive: transitions DRAFT → RECEIVED, which triggers stock movements
        // and recalculates average cost for every product-linked line item.
        const billId = (bill as { id?: string })?.id;
        const matchedItems = validItems.filter((it) => it.productId).length;
        if (billId) {
          try {
            await receiveBill.mutateAsync(billId);
            results.push(
              matchedItems > 0
                ? `Vendor bill received — inventory updated for ${matchedItems} item${matchedItems === 1 ? "" : "s"}`
                : "Vendor bill received",
            );
          } catch (receiveErr: unknown) {
            // Bill was created but receive failed — surface the issue but don't lose the bill
            const rmsg =
              (receiveErr as { response?: { data?: { message?: string } } })?.response?.data?.message ??
              "created in Draft (could not auto-receive — open the bill and click Receive to update stock)";
            results.push(`Vendor bill ${rmsg}`);
          }
        } else {
          results.push("Vendor bill created");
        }
      }

      if (createExpenseRecord) {
        const expenseTotal = createVendorBill ? computedTotal : (scanResult?.total ?? computedTotal);
        await createExpense.mutateAsync({
          categoryId: expenseCategoryId,
          supplierId: supplierId || undefined,
          amount: expenseTotal,
          date: expenseDate,
          description: expenseDescription || scanResult?.supplier || undefined,
          paymentMethod: expensePaymentMethod,
          notes: expenseNotes || undefined,
        });
        results.push("Expense recorded");
      }

      toast({
        title: results.join(" & ") + " successfully!",
        variant: "success",
      });
      onCreated?.();
      onClose();
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || "Failed to create records. Please try again.";
      toast({ title: msg, variant: "error" });
    }
  };

  const isPending = createBill.isPending || receiveBill.isPending || createExpense.isPending;

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
            className="rounded-lg p-1.5 text-navy/40 transition-colors hover:bg-surface-raised hover:text-navy"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {/* Upload Step */}
          {step === "upload" && (
            <div className="p-6">
              <p className="mb-4 text-sm text-navy/60">
                Upload a vendor invoice — one PDF, one image, or all pages of a multi-page
                invoice as separate images. Claude will extract every line item and match
                them to your catalog.
              </p>
              <div
                onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
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
                  <p className="font-medium text-navy">Drop invoice pages here</p>
                  <p className="mt-1 text-sm text-navy/60">
                    or click to browse — select multiple files for multi-page invoices
                  </p>
                  <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
                    {["PDF", "JPEG", "PNG", "HEIC", "WebP", "GIF"].map((label) => (
                      <span
                        key={label}
                        className="inline-flex items-center gap-1 rounded-full bg-white/80 px-2 py-0.5 text-xs font-medium text-navy/60 ring-1 ring-surface-border"
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
              <p className="mt-4 text-center text-xs text-navy/40">
                <Sparkles className="inline h-3 w-3" /> Powered by Claude AI • Up to 10 pages per
                invoice • HEIC iPhone photos supported
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
                <p className="mt-1 text-sm text-navy/60">
                  Claude AI is extracting items and matching products
                </p>
              </div>
            </div>
          )}

          {/* Review Step */}
          {step === "review" && (
            <div className="flex h-full min-h-0 flex-1">
              {/* Left: Invoice Preview */}
              {previewUrl && showPreview && (
                <div className="flex w-1/3 shrink-0 flex-col border-r border-surface-border bg-surface-raised">
                  <div className="flex items-center justify-between border-b border-surface-border px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <FileText className="h-4 w-4 text-brand-500" />
                      <span className="text-xs font-semibold uppercase tracking-wide text-navy/60">
                        Invoice Preview
                        {pagePreviews.length > 1 && (
                          <span className="ml-1.5 rounded-full bg-brand-100 px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-brand-700">
                            Page {previewIndex + 1} of {pagePreviews.length}
                          </span>
                        )}
                      </span>
                    </div>
                    <button onClick={() => setShowPreview(false)} className="rounded p-1 text-navy/30 hover:text-navy transition-colors" title="Hide preview">
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
                      <span className="truncate px-2 text-[11px] text-navy/50" title={pagePreviews[previewIndex]?.name}>
                        {pagePreviews[previewIndex]?.name}
                      </span>
                      <button
                        type="button"
                        onClick={() => setPreviewIndex((i) => Math.min(pagePreviews.length - 1, i + 1))}
                        disabled={previewIndex === pagePreviews.length - 1}
                        className="rounded px-2 py-0.5 text-xs font-medium text-brand-600 transition-colors hover:bg-brand-50 disabled:cursor-not-allowed disabled:text-navy/20 disabled:hover:bg-transparent"
                      >
                        Next →
                      </button>
                    </div>
                  )}
                  <div className="flex-1 overflow-hidden">
                    {previewType === "pdf" ? (
                      <iframe src={previewUrl ?? undefined} className="h-full w-full" style={{ minHeight: "500px" }} title="Invoice PDF" />
                    ) : (() => {
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
                            <p className="text-xs text-navy/50">
                              HEIC preview isn't supported in this browser, but the page was
                              uploaded and Claude is reading it.
                            </p>
                          </div>
                        );
                      }
                      return (
                        <div className="flex h-full items-start justify-center overflow-auto p-2">
                          <img src={previewUrl ?? undefined} alt={`Invoice page ${previewIndex + 1}`} className="max-w-full rounded object-contain" />
                        </div>
                      );
                    })()}
                  </div>
                </div>
              )}
              {/* Right: Form — full width when preview hidden */}
              <div className={previewUrl && showPreview ? "flex-1 overflow-y-auto" : "w-full overflow-y-auto"}>
            <div className="space-y-4 p-6">
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
                  <select
                    value={supplierId}
                    onChange={(e) => setSupplierId(e.target.value)}
                    className="w-full rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                  >
                    <option value="">— Select supplier —</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                  {scanResult?.supplier && (
                    <p className="mt-1 text-xs text-navy/40">Detected: {scanResult.supplier}</p>
                  )}
                </div>
                {(createMode === "bill" || createMode === "both") ? (
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
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                    {scanResult?.expenseCategory && (
                      <p className="mt-1 text-xs text-navy/40">
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
                      <p className="mt-0.5 text-xs text-navy/50">
                        Matched products will be added to inventory when you create the bill.
                      </p>
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
                          const qty = parseFloat(item.qty) || 0;
                          const cost = parseFloat(item.unitCost) || 0;
                          const calculated = qty > 0 && cost > 0 ? qty * cost : null;
                          const invoiceTotal = item.lineTotal;
                          const qtyChanged =
                            item.qty !== item.extractedQty &&
                            item.extractedQty &&
                            item.extractedQty !== "1";
                          const costChanged =
                            item.unitCost !== item.extractedUnitCost && item.extractedUnitCost;
                          return (
                            <tr key={i} className="group align-top transition-colors hover:bg-brand-50/30">
                              <td className="px-3 py-3">
                                <div className="space-y-1.5">
                                  {item.extractedName &&
                                    item.extractedName !== item.description && (
                                      <div className="flex items-start gap-1 text-[11px] text-navy/50">
                                        <Sparkles className="mt-0.5 h-3 w-3 shrink-0 text-brand-400" />
                                        <span className="truncate" title={item.extractedName}>
                                          {item.extractedName}
                                        </span>
                                      </div>
                                    )}
                                  <select
                                    value={item.productId}
                                    onChange={(e) => handleProductSelect(i, e.target.value)}
                                    className="w-full rounded-lg border border-surface-border bg-white px-2.5 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                                  >
                                    <option value="">— Custom item (no inventory link) —</option>
                                    {item.productId &&
                                      !products.find((p) => p.id === item.productId) && (
                                        <option value={item.productId}>{item.description}</option>
                                      )}
                                    {products.map((p) => (
                                      <option key={p.id} value={p.id}>
                                        {p.name}
                                      </option>
                                    ))}
                                  </select>
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
                                <ConfidenceBadge confidence={item.confidence} />
                              </td>
                              <td className="px-2 py-3">
                                <input
                                  type="number"
                                  min="0.001"
                                  step="0.001"
                                  inputMode="decimal"
                                  value={item.qty}
                                  onChange={(e) => updateItem(i, { qty: e.target.value })}
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
                              </td>
                              <td className="px-2 py-3">
                                <div className="relative">
                                  <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-sm text-navy/40">
                                    $
                                  </span>
                                  <input
                                    type="number"
                                    min="0"
                                    step="0.0001"
                                    inputMode="decimal"
                                    value={item.unitCost}
                                    onChange={(e) => updateItem(i, { unitCost: e.target.value })}
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
                      {fmt(createMode === "expense" ? (scanResult?.total ?? 0) : computedTotal)}
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
                      <span className="font-semibold text-navy">{fmt(scanResult.total)}</span>
                    </div>
                  )}
                </div>
              </div>
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
                onClick={() => setStep("upload")}
                className="text-sm text-navy/60 transition-colors hover:text-navy"
              >
                ← Scan again
              </button>
              <div className="flex gap-3">
                <Button variant="secondary" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={() => void handleCreate()}
                  disabled={isPending}
                >
                  {isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Creating...
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="h-4 w-4" />
                      {createMode === "bill"
                        ? "Create Vendor Bill"
                        : createMode === "expense"
                        ? "Record Expense"
                        : "Create Bill & Expense"}
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
    </div>
  );
}
