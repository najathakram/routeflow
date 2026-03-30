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
} from "lucide-react";
import { Button, useToast, cn } from "@routeflow/ui/web";
import { scanInvoice, type ScannedItem, type ScanResult } from "@/lib/api/invoice-scan";
import { useSuppliers } from "@/lib/api/inventory";
import { useProducts } from "@/lib/api/products";
import { useCreateVendorBill } from "@/lib/api/vendor-bills";

const fmt = (n: number | null | undefined) =>
  n != null
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n)
    : "—";

interface ReviewItem {
  extractedName: string;
  productId: string;
  description: string;
  qty: string;
  unitCost: string;
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
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
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
  const [supplierId, setSupplierId] = React.useState("");
  const [billDate, setBillDate] = React.useState(new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = React.useState("");
  const [isDragging, setIsDragging] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const { data: suppliersData } = useSuppliers();
  const suppliers = (suppliersData as { id: string; name: string }[] | undefined) ?? [];

  const { data: productsData } = useProducts({ limit: 500, isActive: true });
  const products =
    (productsData as { data: { id: string; name: string; unit: string; averageCost?: string }[] } | undefined)
      ?.data ?? [];

  const createBill = useCreateVendorBill();

  // Reset when opened
  React.useEffect(() => {
    if (open) {
      setStep("upload");
      setScanResult(null);
      setReviewItems([]);
      setSupplierId("");
      setBillDate(new Date().toISOString().slice(0, 10));
      setDueDate("");
    }
  }, [open]);

  const processFile = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast({ title: "Please upload an image file", variant: "error" });
      return;
    }
    setStep("processing");
    try {
      const result = await scanInvoice(file);
      setScanResult(result);
      const items: ReviewItem[] = (result.items ?? []).map((item) => ({
        extractedName: item.extractedName,
        productId: item.matchedProductId ?? "",
        description: item.matchedProductName ?? item.extractedName,
        qty: String(item.qty ?? 1),
        unitCost: String(item.unitCost ?? ""),
        confidence: item.confidence,
      }));
      setReviewItems(
        items.length > 0
          ? items
          : [
              {
                extractedName: "",
                productId: "",
                description: "",
                qty: "1",
                unitCost: "",
                confidence: "none",
              },
            ],
      );
      // Pre-fill supplier if detected
      if (result.supplier) {
        const match = suppliers.find((s) =>
          s.name.toLowerCase().includes(result.supplier!.toLowerCase()),
        );
        if (match) setSupplierId(match.id);
      }
      if (result.invoiceDate) setBillDate(result.invoiceDate);
      setStep("review");
    } catch (err) {
      console.error(err);
      toast({
        title:
          "Failed to scan invoice. Please try again or ensure ANTHROPIC_API_KEY is configured.",
        variant: "error",
      });
      setStep("upload");
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void processFile(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void processFile(file);
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
      { extractedName: "", productId: "", description: "", qty: "1", unitCost: "", confidence: "none" },
    ]);
  };

  const handleProductSelect = (i: number, productId: string) => {
    const product = products.find((p) => p.id === productId);
    if (product) {
      updateItem(i, {
        productId,
        description: product.name,
        unitCost: product.averageCost
          ? String(parseFloat(product.averageCost).toFixed(4))
          : reviewItems[i].unitCost,
      });
    } else {
      updateItem(i, { productId: "", description: reviewItems[i].extractedName });
    }
  };

  const handleCreateBill = async () => {
    const validItems = reviewItems.filter(
      (item) => item.description && parseFloat(item.qty) > 0,
    );
    if (validItems.length === 0) {
      toast({ title: "Add at least one valid line item", variant: "error" });
      return;
    }
    try {
      await createBill.mutateAsync({
        supplierId: supplierId || "",
        billDate,
        dueDate: dueDate || "",
        items: validItems.map((item) => ({
          description: item.description,
          qty: parseFloat(item.qty) || 1,
          unitCost: parseFloat(item.unitCost) || 0,
        })),
      });
      toast({ title: "Vendor bill created successfully!", variant: "success" });
      onCreated?.();
      onClose();
    } catch {
      toast({ title: "Failed to create vendor bill", variant: "error" });
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
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
                Upload a photo of your vendor invoice and our AI will automatically extract the
                line items and match them to your products.
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
                  <p className="font-medium text-navy">Drop invoice image here</p>
                  <p className="mt-1 text-sm text-navy/60">
                    or click to browse • JPEG, PNG, WebP up to 10MB
                  </p>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={handleFileChange}
                />
              </div>
              <p className="mt-4 text-center text-xs text-navy/40">
                <Sparkles className="inline h-3 w-3" /> Powered by Claude AI • Works with any
                invoice format
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
            <div className="space-y-4 p-6">
              {scanResult?.notes && (
                <div className="flex items-start gap-2 rounded-lg border border-yellow-200 bg-yellow-50 p-3">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600" />
                  <p className="text-xs text-yellow-700">{scanResult.notes}</p>
                </div>
              )}

              {/* Bill Header */}
              <div className="grid grid-cols-2 gap-4 rounded-xl border border-surface-border bg-surface-raised p-4">
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-navy/40">
                    Supplier
                  </label>
                  <select
                    value={supplierId}
                    onChange={(e) => setSupplierId(e.target.value)}
                    className="w-full rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                  >
                    <option value="">— Select supplier —</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  {scanResult?.supplier && (
                    <p className="mt-1 text-xs text-navy/40">
                      Detected: {scanResult.supplier}
                    </p>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-navy/40">
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
                    <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-navy/40">
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
              </div>

              {/* Line Items */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-navy">
                    Extracted Items{" "}
                    <span className="ml-1 rounded-full bg-brand-100 px-2 py-0.5 text-xs text-brand-600">
                      {reviewItems.length}
                    </span>
                  </h3>
                  <p className="text-xs text-navy/40">Review and correct AI-extracted data below</p>
                </div>
                <div className="overflow-hidden rounded-xl border border-surface-border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-surface-border bg-surface-raised">
                        <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-navy/40">
                          Product
                        </th>
                        <th className="w-16 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-navy/40">
                          Qty
                        </th>
                        <th className="w-24 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-navy/40">
                          Unit Cost
                        </th>
                        <th className="w-24 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-navy/40">
                          Total
                        </th>
                        <th className="w-8 px-3 py-2" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-surface-border">
                      {reviewItems.map((item, i) => {
                        const qty = parseFloat(item.qty) || 0;
                        const cost = parseFloat(item.unitCost) || 0;
                        return (
                          <tr key={i} className="group">
                            <td className="px-3 py-2">
                              <div className="space-y-1">
                                {item.extractedName &&
                                  item.extractedName !== item.description && (
                                    <p className="text-[10px] italic text-navy/40">
                                      Extracted: {item.extractedName}
                                    </p>
                                  )}
                                <div className="flex items-center gap-1">
                                  <select
                                    value={item.productId}
                                    onChange={(e) => handleProductSelect(i, e.target.value)}
                                    className="flex-1 rounded border border-surface-border bg-white px-2 py-1 text-xs text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
                                  >
                                    <option value="">— Custom item —</option>
                                    {products.map((p) => (
                                      <option key={p.id} value={p.id}>
                                        {p.name}
                                      </option>
                                    ))}
                                  </select>
                                  <ConfidenceBadge confidence={item.confidence} />
                                </div>
                                {!item.productId && (
                                  <input
                                    type="text"
                                    value={item.description}
                                    onChange={(e) =>
                                      updateItem(i, { description: e.target.value })
                                    }
                                    placeholder="Description"
                                    className="w-full rounded border border-surface-border px-2 py-1 text-xs text-navy placeholder:text-navy/30 focus:outline-none focus:ring-1 focus:ring-brand-500"
                                  />
                                )}
                              </div>
                            </td>
                            <td className="px-3 py-2">
                              <input
                                type="number"
                                min="0.001"
                                step="0.001"
                                value={item.qty}
                                onChange={(e) => updateItem(i, { qty: e.target.value })}
                                className="w-full rounded border border-surface-border px-2 py-1 text-right text-xs text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
                              />
                            </td>
                            <td className="px-3 py-2">
                              <div className="relative">
                                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-navy/40">
                                  $
                                </span>
                                <input
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  value={item.unitCost}
                                  onChange={(e) => updateItem(i, { unitCost: e.target.value })}
                                  className="w-full rounded border border-surface-border py-1 pl-5 pr-2 text-right text-xs text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
                                />
                              </div>
                            </td>
                            <td className="px-3 py-2 text-right text-xs text-navy/60">
                              {qty > 0 && cost > 0 ? fmt(qty * cost) : "—"}
                            </td>
                            <td className="px-3 py-2">
                              <button
                                onClick={() => removeItem(i)}
                                className="rounded p-1 text-navy/20 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-red-50 hover:text-red-500"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
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
                  className="mt-2 text-xs font-medium text-brand-500 transition-colors hover:text-brand-600"
                >
                  + Add line item
                </button>
              </div>

              {/* Totals */}
              <div className="flex justify-end">
                <div className="min-w-[200px] rounded-lg border border-surface-border bg-surface-raised p-3 text-sm">
                  <div className="flex justify-between gap-8">
                    <span className="text-navy/60">Subtotal</span>
                    <span className="font-medium text-navy">
                      {fmt(
                        reviewItems.reduce(
                          (s, item) =>
                            s +
                            (parseFloat(item.qty) || 0) * (parseFloat(item.unitCost) || 0),
                          0,
                        ),
                      )}
                    </span>
                  </div>
                  {scanResult?.tax != null && scanResult.tax > 0 && (
                    <div className="mt-1 flex justify-between gap-8">
                      <span className="text-navy/60">Tax (detected)</span>
                      <span className="text-navy/60">{fmt(scanResult.tax)}</span>
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
                  onClick={() => void handleCreateBill()}
                  disabled={createBill.isPending}
                >
                  {createBill.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Creating...
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="h-4 w-4" /> Create Vendor Bill
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
