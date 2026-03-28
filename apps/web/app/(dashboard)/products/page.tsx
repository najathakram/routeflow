"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Package, LayoutGrid, LayoutList, Plus, Upload, CheckCircle, AlertCircle, Info, Trash2 } from "lucide-react";
import { PageHeader, Table, Badge, Button, Select, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useToast } from "@routeflow/ui/web";
import { useProducts, useCreateProduct, useImportProducts, useBulkDeleteProducts, type ZohoImportItem, type ImportResult } from "@/lib/api/products";

// ─── Types ────────────────────────────────────────────────────────────────────

type StockStatus = "IN_STOCK" | "LOW" | "OUT_OF_STOCK";

interface ApiProduct {
  id: string;
  name: string;
  sku?: string;
  barcode?: string;
  category?: string;
  unit: string;
  pricePerUnit: string;
  isActive: boolean;
  currentStock: number;
  averageCost?: string;
  description?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getStockStatus(p: ApiProduct): StockStatus {
  if (!p.isActive) return "OUT_OF_STOCK";
  if (p.currentStock <= 0) return "OUT_OF_STOCK";
  if (p.currentStock <= 5) return "LOW";
  return "IN_STOCK";
}

// ─── Stock badge ──────────────────────────────────────────────────────────────

function StockBadge({ status }: { status: StockStatus }) {
  if (status === "OUT_OF_STOCK") return <Badge variant="danger" label="Out of Stock" />;
  if (status === "LOW") return <Badge variant="warning" label="Low Stock" />;
  return <Badge variant="success" label="In Stock" />;
}

// ─── Product grid card ────────────────────────────────────────────────────────

function ProductCard({
  product,
  onClick,
  selected,
  onSelect,
  selectionMode,
}: {
  product: ApiProduct;
  onClick: () => void;
  selected: boolean;
  onSelect: (e: React.MouseEvent) => void;
  selectionMode: boolean;
}) {
  const status = getStockStatus(product);
  return (
    <div
      className={cn(
        "relative flex flex-col overflow-hidden rounded-lg border bg-white text-left shadow-card transition-shadow hover:shadow-dropdown cursor-pointer",
        status === "LOW" && "border-warning/40",
        status === "OUT_OF_STOCK" && "border-danger/40",
        status === "IN_STOCK" && "border-surface-border",
        selected && "ring-2 ring-brand-500 border-brand-500",
      )}
      onClick={selectionMode ? onSelect : onClick}
    >
      {/* Checkbox */}
      <div
        className="absolute left-2 top-2 z-10"
        onClick={(e) => { e.stopPropagation(); onSelect(e); }}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={() => {}}
          className="h-4 w-4 cursor-pointer rounded border-navy/30 accent-brand-500"
        />
      </div>

      {/* Image placeholder */}
      <div
        className={cn(
          "flex h-28 w-full items-center justify-center",
          status === "LOW" && "bg-warning-bg",
          status === "OUT_OF_STOCK" && "bg-danger-bg",
          status === "IN_STOCK" && "bg-surface-raised",
        )}
        onClick={selectionMode ? undefined : onClick}
      >
        <Package
          className={cn(
            "h-10 w-10",
            status === "LOW" && "text-warning/40",
            status === "OUT_OF_STOCK" && "text-danger/40",
            status === "IN_STOCK" && "text-navy/20",
          )}
        />
      </div>

      {/* Info */}
      <div
        className="flex flex-1 flex-col gap-2 p-3"
        onClick={selectionMode ? undefined : onClick}
      >
        <div>
          <p className="text-xs text-navy/40">{product.sku}</p>
          <p className="mt-0.5 text-sm font-semibold leading-snug text-navy line-clamp-2">
            {product.name}
          </p>
        </div>
        <div className="mt-auto flex items-end justify-between gap-1">
          <p className="text-base font-bold text-navy">
            ${parseFloat(String(product.pricePerUnit)).toFixed(2)}
            <span className="ml-1 text-xs font-normal text-navy/40">
              / {product.unit}
            </span>
          </p>
        </div>
        <StockBadge status={status} />
      </div>
    </div>
  );
}

// ─── Table column defs ────────────────────────────────────────────────────────

function makeTableColumns(
  selected: Set<string>,
  onToggle: (id: string) => void,
  allIds: string[],
  onToggleAll: () => void,
): ColumnDef<ApiProduct, unknown>[] {
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const someSelected = !allSelected && allIds.some((id) => selected.has(id));

  return [
    {
      id: "select",
      header: () => (
        <input
          type="checkbox"
          checked={allSelected}
          ref={(el) => { if (el) el.indeterminate = someSelected; }}
          onChange={onToggleAll}
          className="h-4 w-4 cursor-pointer rounded border-navy/30 accent-brand-500"
        />
      ),
      cell: ({ row }) => (
        <input
          type="checkbox"
          checked={selected.has(row.original.id)}
          onChange={() => onToggle(row.original.id)}
          onClick={(e) => e.stopPropagation()}
          className="h-4 w-4 cursor-pointer rounded border-navy/30 accent-brand-500"
        />
      ),
      enableSorting: false,
      size: 40,
    },
    {
      accessorKey: "name",
      header: "Product",
      cell: ({ row }) => (
        <div>
          <p className="font-medium text-navy">{row.original.name}</p>
          <p className="text-xs text-navy/40">{row.original.sku}</p>
        </div>
      ),
    },
    {
      accessorKey: "category",
      header: "Category",
      cell: ({ row }) => <span className="text-navy/70">{row.original.category}</span>,
    },
    {
      accessorKey: "unit",
      header: "Unit",
      enableSorting: false,
      cell: ({ row }) => <span className="text-navy/60">{row.original.unit}</span>,
    },
    {
      accessorKey: "pricePerUnit",
      header: "Price",
      cell: ({ row }) => (
        <span className="font-medium text-navy">
          ${parseFloat(String(row.original.pricePerUnit)).toFixed(2)}
        </span>
      ),
    },
    {
      accessorKey: "currentStock",
      header: "Stock",
      cell: ({ row }) => {
        const status = getStockStatus(row.original);
        return (
          <div className="flex items-center gap-2">
            <StockBadge status={status} />
            <span className="text-xs text-navy/50">
              {Number(row.original.currentStock).toFixed(0)} {row.original.unit}
            </span>
          </div>
        );
      },
    },
  ];
}

// ─── Create product modal ──────────────────────────────────────────────────────

function CreateProductModal({
  onClose,
  onCreate,
  isLoading,
}: {
  onClose: () => void;
  onCreate: (data: Record<string, unknown>) => Promise<unknown>;
  isLoading: boolean;
}) {
  const [form, setForm] = React.useState({
    name: "", sku: "", barcode: "", unit: "", pricePerUnit: "", category: "", description: "",
  });

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onCreate({
      name: form.name,
      sku: form.sku || undefined,
      barcode: form.barcode || undefined,
      unit: form.unit,
      pricePerUnit: form.pricePerUnit,
      category: form.category || undefined,
      description: form.description || undefined,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-xl border border-surface-border bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <h2 className="text-base font-semibold text-navy">New Product</h2>
          <button onClick={onClose} className="text-navy/40 hover:text-navy transition-colors">✕</button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4 p-6">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="mb-1 block text-sm font-medium text-navy">Name *</label>
              <input required value={form.name} onChange={(e) => set("name", e.target.value)}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-navy">SKU</label>
              <input value={form.sku} onChange={(e) => set("sku", e.target.value)}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-navy">Barcode</label>
              <input value={form.barcode} onChange={(e) => set("barcode", e.target.value)}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-navy">Unit *</label>
              <input required placeholder="e.g. case, kg, unit" value={form.unit} onChange={(e) => set("unit", e.target.value)}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-navy">Price per unit *</label>
              <input required type="number" min="0" step="0.01" value={form.pricePerUnit} onChange={(e) => set("pricePerUnit", e.target.value)}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div className="col-span-2">
              <label className="mb-1 block text-sm font-medium text-navy">Category</label>
              <input value={form.category} onChange={(e) => set("category", e.target.value)}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div className="col-span-2">
              <label className="mb-1 block text-sm font-medium text-navy">Description</label>
              <textarea rows={2} value={form.description} onChange={(e) => set("description", e.target.value)}
                className="w-full resize-y rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={isLoading}>Create Product</Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Zoho CSV parser ──────────────────────────────────────────────────────────

/**
 * Splits CSV text into rows, correctly handling quoted fields that contain
 * embedded newlines (e.g. Zoho's "Items - Updated" export format).
 */
function splitCsvRows(text: string): string[] {
  const rows: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        // Escaped double-quote inside a quoted field
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
        current += ch;
      }
    } else if ((ch === "\r" || ch === "\n") && !inQuotes) {
      // Skip \n that follows a \r
      if (ch === "\r" && text[i + 1] === "\n") i++;
      if (current.trim()) rows.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) rows.push(current);
  return rows;
}

/** Parses one CSV row into fields, handling quoted fields with embedded commas. */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function parseZohoCsv(text: string): ZohoImportItem[] {
  const rows = splitCsvRows(text);
  if (rows.length < 2) return [];

  // Parse header — strip BOM if present
  const headers = parseCSVLine(rows[0].replace(/^\uFEFF/, ""));

  // Look up a column by trying multiple possible header names (Zoho changes them between export types)
  const colAlt = (row: string[], ...keys: string[]): string => {
    for (const key of keys) {
      const idx = headers.indexOf(key);
      if (idx >= 0) return (row[idx] ?? "").trim();
    }
    return "";
  };

  const parsePrice = (raw: string): string | undefined => {
    const cleaned = raw.replace(/^USD\s*/i, "").replace(/,/g, "").trim();
    const num = parseFloat(cleaned);
    return isNaN(num) ? undefined : num.toFixed(2);
  };

  const items: ZohoImportItem[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = parseCSVLine(rows[i]);
    if (row.every((c) => c === "")) continue;

    const name = colAlt(row, "Item Name");
    if (!name) continue;

    // Price: "Selling Price" (full export) or "Rate" (simplified export)
    const rawPrice = colAlt(row, "Selling Price", "Rate");
    const pricePerUnit = parsePrice(rawPrice);
    if (!pricePerUnit) continue;

    // Unit: full export uses "Unit Name" / "Unit"; simplified export uses "Usage unit"
    const unit = colAlt(row, "Unit Name", "Unit", "Usage unit") || "pcs";

    // SKU
    const rawSku = colAlt(row, "SKU");
    const sku = rawSku || undefined;

    // Barcode: full export has UPC/EAN columns; simplified export puts barcode in SKU
    const upc = colAlt(row, "UPC");
    const ean = colAlt(row, "EAN");
    // If no UPC/EAN columns exist and SKU looks like a numeric barcode, use it as barcode
    const skuLooksLikeBarcode = !!rawSku && /^\d{8,14}$/.test(rawSku);
    const barcode = upc || ean || (skuLooksLikeBarcode ? rawSku : undefined) || undefined;

    // Description: "Sales Description" (full) or "Description" (simplified)
    const description = colAlt(row, "Sales Description", "Description") || undefined;

    // Category
    const category = colAlt(row, "Category Name") || undefined;

    // Status
    const statusRaw = colAlt(row, "Status");
    const isActive = statusRaw === "" ? true : statusRaw.toLowerCase() === "active";

    // Stock on hand (full export only)
    const stockRaw = colAlt(row, "Stock On Hand", "Opening Stock");
    const stockNum = parseFloat(stockRaw.replace(/,/g, ""));
    const currentStock = !isNaN(stockNum) ? stockNum.toFixed(3) : undefined;

    // Average cost / purchase price (full export only)
    const averageCost = parsePrice(colAlt(row, "Purchase Price"));

    // Reorder level (full export only)
    const reorderNum = parseInt(colAlt(row, "Reorder Level"), 10);
    const reorderPoint = !isNaN(reorderNum) ? reorderNum : undefined;

    items.push({
      name,
      sku,
      barcode,
      unit,
      pricePerUnit,
      category,
      description,
      isActive,
      currentStock,
      averageCost,
      reorderPoint,
    });
  }

  return items;
}

// ─── Zoho import modal ────────────────────────────────────────────────────────

type ImportStep = "upload" | "preview" | "result";

function ZohoImportModal({
  onClose,
  onImport,
  isImporting,
}: {
  onClose: () => void;
  onImport: (items: ZohoImportItem[]) => Promise<ImportResult>;
  isImporting: boolean;
}) {
  const [step, setStep] = React.useState<ImportStep>("upload");
  const [parsedItems, setParsedItems] = React.useState<ZohoImportItem[]>([]);
  const [parseError, setParseError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<ImportResult | null>(null);
  const [fileName, setFileName] = React.useState<string>("");
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = React.useState(false);

  const handleFile = (file: File) => {
    if (!file.name.endsWith(".csv")) {
      setParseError("Please upload a .csv file exported from Zoho.");
      return;
    }
    setParseError(null);
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      try {
        const items = parseZohoCsv(text);
        if (items.length === 0) {
          setParseError("No valid items found in the CSV. Make sure you exported Items from Zoho Inventory.");
          return;
        }
        setParsedItems(items);
        setStep("preview");
      } catch (err) {
        setParseError("Failed to parse CSV file. Please check the file format.");
      }
    };
    reader.readAsText(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  const handleImport = async () => {
    const res = await onImport(parsedItems);
    setResult(res);
    setStep("result");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl rounded-xl border border-surface-border bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <div className="flex items-center gap-3">
            <Upload className="h-5 w-5 text-brand-500" />
            <h2 className="text-base font-semibold text-navy">Import Items from Zoho</h2>
          </div>
          <button onClick={onClose} className="text-navy/40 hover:text-navy transition-colors text-lg leading-none">✕</button>
        </div>

        {/* Step: upload */}
        {step === "upload" && (
          <div className="space-y-5 p-6">
            {/* Instructions */}
            <div className="rounded-lg border border-brand-500/20 bg-brand-500/5 p-4">
              <div className="flex gap-2">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" />
                <div className="text-sm text-navy/70 space-y-1">
                  <p className="font-medium text-navy">How to export your items from Zoho Inventory:</p>
                  <ol className="list-decimal list-inside space-y-0.5 text-xs">
                    <li>Open <strong>Zoho Inventory</strong> and go to <strong>Items</strong> (left sidebar)</li>
                    <li>Click the <strong>Hamburger menu</strong> (☰) or <strong>Export</strong> button at the top right</li>
                    <li>Select <strong>Export Items</strong></li>
                    <li>Choose <strong>CSV</strong> format and click <strong>Export</strong></li>
                    <li>Save the downloaded <code className="bg-navy/10 px-1 rounded text-xs">Item.csv</code> file</li>
                    <li>Upload it here</li>
                  </ol>
                </div>
              </div>
            </div>

            {/* Drop zone */}
            <div
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileRef.current?.click()}
              className={cn(
                "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-10 transition-colors",
                isDragging
                  ? "border-brand-500 bg-brand-500/5"
                  : "border-surface-border bg-surface-raised hover:border-brand-500/50 hover:bg-brand-500/5",
              )}
            >
              <Upload className="h-8 w-8 text-navy/30" />
              <div className="text-center">
                <p className="text-sm font-medium text-navy">Drop your Zoho CSV here</p>
                <p className="text-xs text-navy/40">or click to browse — accepts <code>.csv</code> files only</p>
              </div>
              {fileName && (
                <p className="text-xs font-medium text-brand-500">Selected: {fileName}</p>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={handleFileInput}
            />

            {parseError && (
              <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-bg p-3 text-sm text-danger">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {parseError}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={onClose}>Cancel</Button>
            </div>
          </div>
        )}

        {/* Step: preview */}
        {step === "preview" && (
          <div className="flex flex-col" style={{ maxHeight: "70vh" }}>
            <div className="border-b border-surface-border px-6 py-3">
              <p className="text-sm text-navy/70">
                <span className="font-semibold text-navy">{parsedItems.length}</span> items found in{" "}
                <span className="font-medium text-brand-500">{fileName}</span>. Review and click Import.
              </p>
            </div>
            <div className="overflow-auto flex-1">
              <table className="min-w-full text-xs">
                <thead className="sticky top-0 bg-surface-raised border-b border-surface-border">
                  <tr>
                    {["Name", "SKU", "Barcode", "Unit", "Price", "Category", "Stock"].map((h) => (
                      <th key={h} className="px-3 py-2 text-left font-semibold text-navy/60 whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {parsedItems.map((item, i) => (
                    <tr key={i} className="border-b border-surface-border hover:bg-surface-raised">
                      <td className="px-3 py-2 font-medium text-navy max-w-[200px] truncate" title={item.name}>{item.name}</td>
                      <td className="px-3 py-2 text-navy/60">{item.sku ?? "—"}</td>
                      <td className="px-3 py-2 text-navy/60">{item.barcode ?? "—"}</td>
                      <td className="px-3 py-2 text-navy/60">{item.unit}</td>
                      <td className="px-3 py-2 text-navy">${item.pricePerUnit}</td>
                      <td className="px-3 py-2 text-navy/60">{item.category ?? "—"}</td>
                      <td className="px-3 py-2 text-navy/60">{item.currentStock ?? "0"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t border-surface-border px-6 py-4">
              <button
                onClick={() => { setStep("upload"); setParsedItems([]); setFileName(""); }}
                className="text-sm text-navy/50 hover:text-navy transition-colors"
              >
                ← Choose different file
              </button>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={onClose}>Cancel</Button>
                <Button leftIcon={<Upload className="h-4 w-4" />} onClick={handleImport} loading={isImporting}>
                  Import {parsedItems.length} Items
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Step: result */}
        {step === "result" && result && (
          <div className="space-y-4 p-6">
            <div className="flex items-start gap-3">
              <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-success" />
              <div>
                <p className="font-semibold text-navy">Import complete</p>
                <p className="text-sm text-navy/60">
                  <span className="font-medium text-success">{result.created}</span> items created
                  {result.skipped > 0 && (
                    <>, <span className="font-medium text-warning">{result.skipped}</span> skipped (SKU or barcode already exists)</>
                  )}
                  {result.errors.length > 0 && (
                    <>, <span className="font-medium text-danger">{result.errors.length}</span> failed</>
                  )}
                </p>
              </div>
            </div>

            {result.errors.length > 0 && (
              <div className="rounded-lg border border-danger/30 bg-danger-bg p-3">
                <p className="mb-2 text-xs font-semibold text-danger">Failed rows:</p>
                <ul className="space-y-1 text-xs text-danger">
                  {result.errors.map((e, i) => (
                    <li key={i}>Row {e.row}: <strong>{e.name}</strong> — {e.reason}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex justify-end">
              <Button onClick={onClose}>Done</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ProductsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setTitle } = usePageTitle();
  const { toast } = useToast();

  React.useEffect(() => { setTitle("Products"); }, [setTitle]);

  const [search, setSearch] = React.useState("");
  const [categoryFilter, setCategoryFilter] = React.useState("");
  const [stockFilter, setStockFilter] = React.useState("");
  const [viewMode, setViewMode] = React.useState<"grid" | "table">("grid");
  const [showCreate, setShowCreate] = React.useState(false);
  const [showImport, setShowImport] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const createProduct = useCreateProduct();
  const importProducts = useImportProducts();
  const bulkDelete = useBulkDeleteProducts();

  const { data: result, isLoading } = useProducts({
    search,
    category: categoryFilter || undefined,
    isActive: stockFilter === "OUT_OF_STOCK" ? false : undefined,
  });

  const productList: ApiProduct[] = result?.data ?? [];

  const categories = Array.from(
    new Set(productList.map((p) => p.category).filter(Boolean))
  ) as string[];

  const filtered = React.useMemo(() => {
    if (stockFilter === "IN_STOCK") return productList.filter((p) => getStockStatus(p) === "IN_STOCK");
    if (stockFilter === "LOW") return productList.filter((p) => getStockStatus(p) === "LOW");
    return productList;
  }, [productList, stockFilter]);

  const filteredIds = filtered.map((p) => p.id);
  const allFilteredSelected = filteredIds.length > 0 && filteredIds.every((id) => selected.has(id));

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const toggleAll = () =>
    setSelected((prev) => {
      if (allFilteredSelected) {
        const next = new Set(prev);
        filteredIds.forEach((id) => next.delete(id));
        return next;
      }
      return new Set([...prev, ...filteredIds]);
    });

  const handleBulkDelete = async () => {
    const ids = Array.from(selected);
    try {
      const res = await bulkDelete.mutateAsync(ids);
      setSelected(new Set());
      toast({ title: `${res.deleted} product${res.deleted !== 1 ? "s" : ""} deleted`, variant: "success" });
    } catch {
      toast({ title: "Failed to delete products", variant: "error" });
    }
  };

  const tableColumns = React.useMemo(
    () => makeTableColumns(selected, toggleOne, filteredIds, toggleAll),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, filteredIds.join(","), allFilteredSelected],
  );

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Products"
        subtitle="Manage your product catalog"
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              leftIcon={<Upload className="h-4 w-4" />}
              onClick={() => setShowImport(true)}
            >
              Import from Zoho
            </Button>
            <Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => setShowCreate(true)}>
              New Product
            </Button>
          </div>
        }
      />

      {/* Create product modal */}
      {showCreate && (
        <CreateProductModal
          onClose={() => setShowCreate(false)}
          onCreate={(data) =>
            createProduct.mutateAsync(data, {
              onSuccess: () => {
                setShowCreate(false);
                toast({ title: "Product created", variant: "success" });
              },
              onError: (err: Error) => toast({ title: "Failed", description: err.message, variant: "error" }),
            })
          }
          isLoading={createProduct.isPending}
        />
      )}

      {/* Zoho import modal */}
      {showImport && (
        <ZohoImportModal
          onClose={() => setShowImport(false)}
          onImport={(items) => importProducts.mutateAsync(items)}
          isImporting={importProducts.isPending}
        />
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Select all checkbox */}
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={allFilteredSelected}
            ref={(el) => {
              if (el) el.indeterminate = !allFilteredSelected && filteredIds.some((id) => selected.has(id));
            }}
            onChange={toggleAll}
            className="h-4 w-4 cursor-pointer rounded border-navy/30 accent-brand-500"
          />
          <span className="text-sm text-navy/60">Select all</span>
        </label>

        <input
          type="search"
          placeholder="Search by name or SKU…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-10 w-64 rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/40 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <div className="w-44">
          <Select
            options={[
              { value: "", label: "All Categories" },
              ...categories.map((c) => ({ value: c, label: c })),
            ]}
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
          />
        </div>
        <div className="w-40">
          <Select
            options={[
              { value: "", label: "All Stock" },
              { value: "IN_STOCK", label: "In Stock" },
              { value: "LOW", label: "Low Stock" },
              { value: "OUT_OF_STOCK", label: "Out of Stock" },
            ]}
            value={stockFilter}
            onChange={(e) => setStockFilter(e.target.value)}
          />
        </div>

        {/* View toggle */}
        <div className="ml-auto flex items-center rounded-lg border border-surface-border bg-white p-1">
          <button
            onClick={() => setViewMode("grid")}
            className={cn(
              "rounded p-1.5 transition-colors",
              viewMode === "grid" ? "bg-navy text-white" : "text-navy/40 hover:text-navy",
            )}
            title="Grid view"
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
          <button
            onClick={() => setViewMode("table")}
            className={cn(
              "rounded p-1.5 transition-colors",
              viewMode === "table" ? "bg-navy text-white" : "text-navy/40 hover:text-navy",
            )}
            title="Table view"
          >
            <LayoutList className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Selection action bar */}
      {selected.size > 0 && (
        <div className="flex items-center justify-between rounded-lg border border-danger/30 bg-danger-bg px-4 py-3">
          <span className="text-sm font-medium text-navy">
            {selected.size} item{selected.size !== 1 ? "s" : ""} selected
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSelected(new Set())}
              className="text-sm text-navy/50 hover:text-navy transition-colors"
            >
              Deselect all
            </button>
            <Button
              variant="danger"
              leftIcon={<Trash2 className="h-4 w-4" />}
              loading={bulkDelete.isPending}
              onClick={handleBulkDelete}
            >
              Delete {selected.size} item{selected.size !== 1 ? "s" : ""}
            </Button>
          </div>
        </div>
      )}

      {/* Content */}
      {isLoading ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <div
              key={i}
              className="h-48 animate-pulse rounded-lg border border-surface-border bg-surface-raised"
            />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-surface-border bg-white py-12 text-center">
          <p className="text-sm text-navy/40">No products match your filters.</p>
        </div>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {filtered.map((p) => (
            <ProductCard
              key={p.id}
              product={p}
              selected={selected.has(p.id)}
              selectionMode={selected.size > 0}
              onSelect={(e) => { e.stopPropagation(); toggleOne(p.id); }}
              onClick={() => router.push(`/products/${p.id}`)}
            />
          ))}
        </div>
      ) : (
        <Table
          data={filtered}
          columns={tableColumns}
          onRowClick={(row) => {
            if (selected.size > 0) toggleOne(row.original.id);
            else router.push(`/products/${row.original.id}`);
          }}
        />
      )}
    </div>
  );
}
