"use client";

import React from "react";
import { usePageTitle } from "@/lib/page-title-context";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@routeflow/ui/web";
import {
  Upload,
  CheckCircle2,
  AlertCircle,
  FileText,
  Users,
  DollarSign,
  Receipt,
  Package,
  ChevronDown,
  ChevronUp,
  BarChart3,
  Hash,
  ClipboardList,
} from "lucide-react";
import { cn } from "@routeflow/ui/web";
import {
  useNumberingSettings,
  useUpdateNumbering,
  formatDocumentNumber,
  type DocumentNumberType,
} from "@/lib/api/numbering";
import {
  useIncompleteProducts,
  useCompleteSetup,
  type IncompleteProduct,
} from "@/lib/api/import-resolution";

interface ImportResult {
  imported?: number;
  updated?: number;
  created?: number;
  skipped?: number;
  errors: string[];
  suppliersCreated?: number;
  suppliersUpdated?: number;
}

interface ImportSection {
  id: string;
  label: string;
  description: string;
  endpoint: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  zohoExportPath: string;
}

const IMPORT_SECTIONS: ImportSection[] = [
  {
    id: "products",
    label: "Products (Items)",
    description: "Import products and pricing from Zoho Inventory Items CSV export",
    endpoint: "/import/products",
    icon: Package,
    color: "text-purple-500 bg-purple-50",
    zohoExportPath: "Zoho Inventory → Items → ≡ → Export Items → CSV",
  },
  {
    id: "contacts",
    label: "Customers (Contacts)",
    description: "Import customers from Zoho Contacts CSV export",
    endpoint: "/import/contacts",
    icon: Users,
    color: "text-brand-500 bg-brand-50",
    zohoExportPath: "Zoho Invoices → Contacts → ⋮ → Export Contacts",
  },
  {
    id: "inventory",
    label: "Inventory Stock Levels",
    description:
      "Sync current stock quantities from Zoho Stock Summary Report (Item Name, SKU, Closing Stock)",
    endpoint: "/import/inventory",
    icon: BarChart3,
    color: "text-teal-500 bg-teal-50",
    zohoExportPath: "Zoho Inventory → Reports → Stock Summary → Export as CSV",
  },
  {
    id: "invoices",
    label: "Invoices",
    description: "Import invoices and line items from Zoho Invoice CSV export",
    endpoint: "/import/invoices",
    icon: FileText,
    color: "text-orange-500 bg-orange-50",
    zohoExportPath: "Zoho Invoices → Invoices → ⋮ → Export Invoices",
  },
  {
    id: "payments",
    label: "Customer Payments",
    description: "Import payment history from Zoho Customer Payments CSV",
    endpoint: "/import/payments",
    icon: DollarSign,
    color: "text-success bg-success-bg",
    zohoExportPath: "Zoho Invoices → Customer Payments → ⋮ → Export",
  },
  {
    id: "expenses",
    label: "Expenses",
    description:
      "Import expense records from Zoho Expense CSV. Suppliers are auto-created from vendor names — no separate supplier import needed.",
    endpoint: "/import/expenses",
    icon: Receipt,
    color: "text-danger bg-danger-bg",
    zohoExportPath: "Zoho Expense → My Expenses → Export",
  },
];

const STEP_LABELS = ["Products", "Customers", "Inventory", "Invoices", "Payments", "Expenses"];

// ─── Import Card ──────────────────────────────────────────────────────────────

function ImportCard({ section, step }: { section: ImportSection; step: number }) {
  const { toast } = useToast();
  const [file, setFile] = React.useState<File | null>(null);
  const [result, setResult] = React.useState<ImportResult | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [showErrors, setShowErrors] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const Icon = section.icon;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      setFile(f);
      setResult(null);
      setShowErrors(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f && f.name.endsWith(".csv")) {
      setFile(f);
      setResult(null);
    }
  };

  const handleImport = async () => {
    if (!file) return;
    setLoading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await apiClient.post(section.endpoint, formData, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 300_000, // 5 min for large files
      });
      setResult(res.data);
      const d = res.data;
      const skipped = d.skipped ?? 0;
      const created = d.created ?? d.imported ?? 0;
      let summary =
        d.updated !== undefined
          ? `${d.updated} updated, ${created} created, ${skipped} skipped`
          : `${d.imported} records imported, ${skipped} skipped`;
      if (d.suppliersCreated || d.suppliersUpdated) {
        const parts: string[] = [];
        if (d.suppliersCreated)
          parts.push(
            `${d.suppliersCreated} supplier${d.suppliersCreated !== 1 ? "s" : ""} created`,
          );
        if (d.suppliersUpdated)
          parts.push(
            `${d.suppliersUpdated} supplier${d.suppliersUpdated !== 1 ? "s" : ""} matched`,
          );
        summary += ` · ${parts.join(", ")}`;
      }
      toast({ title: `${section.label} imported`, description: summary, variant: "success" });
    } catch (err: any) {
      toast({
        title: "Import failed",
        description: err?.response?.data?.message ?? "Please check your file format and try again",
        variant: "error",
      });
    } finally {
      setLoading(false);
    }
  };

  const skipped = result?.skipped ?? 0;

  return (
    <div className="rounded-xl border border-surface-border bg-white overflow-hidden flex flex-col">
      {/* Header */}
      <div className="flex items-start gap-3 border-b border-surface-border p-4">
        <span
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
            section.color,
          )}
        >
          <Icon className="h-5 w-5" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-navy/10 text-[11px] font-bold text-navy/70 shrink-0">
              {step}
            </span>
            <p className="font-semibold text-navy">{section.label}</p>
          </div>
          <p className="text-xs text-navy/70 mt-0.5 leading-relaxed">{section.description}</p>
        </div>
        {result && (
          <div className="flex flex-col items-end gap-1 text-xs shrink-0">
            <span className="flex items-center gap-1 text-success">
              <CheckCircle2 className="h-3.5 w-3.5" />
              {result.updated !== undefined
                ? `${result.updated} updated, ${result.created ?? result.imported ?? 0} created`
                : `${result.imported} imported`}
            </span>
            {skipped > 0 && (
              <span className="flex items-center gap-1 text-warning">
                <AlertCircle className="h-3.5 w-3.5" />
                {skipped} skipped
              </span>
            )}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex flex-col flex-1 gap-3 p-4">
        {/* Export hint */}
        <div className="flex items-start gap-2 rounded-lg bg-surface-raised px-3 py-2 text-xs text-navy/70">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-navy/70" />
          <span>
            <strong className="text-navy/70">How to export:</strong> {section.zohoExportPath}
          </span>
        </div>

        {/* Drop zone */}
        <div
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          onClick={() => inputRef.current?.click()}
          className={cn(
            "flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 cursor-pointer transition-colors min-h-[100px]",
            file
              ? "border-brand-300 bg-brand-50"
              : "border-surface-border hover:border-brand-300 hover:bg-brand-50/30",
          )}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={handleFileChange}
          />
          <Upload className={cn("h-6 w-6", file ? "text-brand-500" : "text-navy/30")} />
          {file ? (
            <div className="text-center">
              <p className="text-sm font-medium text-brand-600">{file.name}</p>
              <p className="text-xs text-navy/70">
                {(file.size / 1024).toFixed(1)} KB · Click to change
              </p>
            </div>
          ) : (
            <div className="text-center">
              <p className="text-sm text-navy/70">
                Drop CSV file here or <span className="text-brand-500">browse</span>
              </p>
              <p className="text-xs text-navy/70 mt-0.5">Zoho CSV export format</p>
            </div>
          )}
        </div>

        {/* Import button */}
        <button
          onClick={handleImport}
          disabled={!file || loading}
          className="w-full rounded-lg bg-brand-500 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-40 transition-colors"
        >
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              Importing…
            </span>
          ) : (
            `Import ${section.label}`
          )}
        </button>

        {/* Errors */}
        {result && result.errors.length > 0 && (
          <div className="rounded-lg border border-warning/30 bg-warning-bg/50 px-3 py-2">
            <button
              onClick={() => setShowErrors((v) => !v)}
              className="flex w-full items-center justify-between text-xs font-medium text-warning"
            >
              <span>
                {result.errors.length} error{result.errors.length > 1 ? "s" : ""} during import
              </span>
              {showErrors ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
            </button>
            {showErrors && (
              <ul className="mt-2 space-y-0.5 text-xs text-navy/70 max-h-32 overflow-y-auto">
                {result.errors.slice(0, 20).map((e, i) => (
                  <li key={i} className="truncate">
                    • {e}
                  </li>
                ))}
                {result.errors.length > 20 && (
                  <li className="text-navy/70">…and {result.errors.length - 20} more</li>
                )}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Document numbering (spec §1: continuity) ─────────────────────────────────

const DOC_TYPE_LABELS: Record<DocumentNumberType, string> = {
  INVOICE: "Invoices",
  ESTIMATE: "Estimates",
  CREDIT_NOTE: "Credit notes",
  PAYMENT: "Payments",
};

interface NumberingDraft {
  prefix: string;
  nextNumber: number;
  padding: number;
}

function NumberingRow({
  docType,
  draft,
  serverPreview,
  dirty,
  saving,
  onChange,
  onSave,
}: {
  docType: DocumentNumberType;
  draft: NumberingDraft;
  serverPreview: string;
  dirty: boolean;
  saving: boolean;
  onChange: (patch: Partial<NumberingDraft>) => void;
  onSave: () => void;
}) {
  const preview = dirty
    ? formatDocumentNumber(draft.prefix, draft.nextNumber, draft.padding)
    : serverPreview;
  return (
    <div className="grid grid-cols-[120px_1fr_110px_90px_1fr_auto] items-center gap-3 border-b border-surface-border px-4 py-3 last:border-b-0">
      <span className="text-sm font-medium text-navy">{DOC_TYPE_LABELS[docType]}</span>
      <input
        aria-label={`${DOC_TYPE_LABELS[docType]} prefix`}
        value={draft.prefix}
        onChange={(e) => onChange({ prefix: e.target.value })}
        placeholder="Prefix"
        className="rounded-lg border border-surface-border px-2.5 py-1.5 text-sm font-mono text-navy focus:border-brand-400 focus:outline-none"
      />
      <input
        aria-label={`${DOC_TYPE_LABELS[docType]} next number`}
        type="number"
        min={1}
        max={2_000_000_000}
        value={Number.isFinite(draft.nextNumber) ? draft.nextNumber : ""}
        onChange={(e) => {
          const v = parseInt(e.target.value, 10);
          onChange({ nextNumber: Number.isNaN(v) ? NaN : Math.min(2_000_000_000, v) });
        }}
        className="rounded-lg border border-surface-border px-2.5 py-1.5 text-sm font-mono text-right text-navy focus:border-brand-400 focus:outline-none"
      />
      <input
        aria-label={`${DOC_TYPE_LABELS[docType]} padding`}
        type="number"
        min={0}
        max={12}
        value={Number.isFinite(draft.padding) ? draft.padding : ""}
        onChange={(e) => {
          const v = parseInt(e.target.value, 10);
          onChange({ padding: Number.isNaN(v) ? NaN : Math.min(12, Math.max(0, v)) });
        }}
        className="rounded-lg border border-surface-border px-2.5 py-1.5 text-sm font-mono text-right text-navy focus:border-brand-400 focus:outline-none"
      />
      <span className="truncate font-mono text-sm text-navy/70">
        next: <span className="font-semibold text-navy">{preview}</span>
      </span>
      <button
        onClick={onSave}
        disabled={!dirty || saving}
        className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-40 transition-colors"
      >
        {saving ? "Saving…" : "Save"}
      </button>
    </div>
  );
}

function NumberingCard() {
  const { toast } = useToast();
  const { data: settings, isLoading } = useNumberingSettings();
  const updateNumbering = useUpdateNumbering();
  const [drafts, setDrafts] = React.useState<Record<string, NumberingDraft>>({});
  const [savingType, setSavingType] = React.useState<DocumentNumberType | null>(null);

  // Seed a draft per doc type from the server once; keep local edits afterwards.
  React.useEffect(() => {
    if (!settings) return;
    setDrafts((prev) => {
      const next = { ...prev };
      for (const s of settings) {
        if (!next[s.docType]) {
          next[s.docType] = { prefix: s.prefix, nextNumber: s.nextNumber, padding: s.padding };
        }
      }
      return next;
    });
  }, [settings]);

  const save = (docType: DocumentNumberType) => {
    const d = drafts[docType];
    if (!d) return;
    if (!Number.isFinite(d.nextNumber) || d.nextNumber < 1) {
      toast({ title: "Enter a next number of 1 or more", variant: "error" });
      return;
    }
    setSavingType(docType);
    updateNumbering.mutate(
      {
        docType,
        data: {
          prefix: d.prefix,
          nextNumber: d.nextNumber,
          padding: Number.isFinite(d.padding) ? d.padding : 0,
        },
      },
      {
        onSuccess: (row) => {
          // Reconcile the draft to the server-normalized row so the dirty flag
          // clears after every save (covers NaN/clamped inputs that would
          // otherwise never round-trip to equality).
          setDrafts((prev) => ({
            ...prev,
            [docType]: { prefix: row.prefix, nextNumber: row.nextNumber, padding: row.padding },
          }));
          toast({
            title: `${DOC_TYPE_LABELS[docType]} numbering saved`,
            description: `Next ${DOC_TYPE_LABELS[docType].toLowerCase()} will be ${row.preview}`,
            variant: "success",
          });
        },
        onError: (e: any) => {
          toast({
            title: "Could not save numbering",
            description: e?.response?.data?.message ?? e.message,
            variant: "error",
          });
        },
        onSettled: () => setSavingType(null),
      },
    );
  };

  return (
    <div className="rounded-xl border border-surface-border bg-white overflow-hidden">
      <div className="flex items-start gap-3 border-b border-surface-border p-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-navy/5 text-navy/70">
          <Hash className="h-5 w-5" />
        </span>
        <div className="flex-1">
          <p className="font-semibold text-navy">Document numbering</p>
          <p className="text-xs text-navy/70 mt-0.5 leading-relaxed">
            Continue where your old system left off — set the next number for each document type
            (e.g. last invoice <span className="font-mono">INV-08841</span> → next{" "}
            <span className="font-mono">INV-08842</span>). Imported documents keep their original
            numbers; if a number already exists we skip to the next free one and note it on the
            document.
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="p-6 text-sm text-navy/50">Loading numbering…</div>
      ) : (
        <>
          <div className="grid grid-cols-[120px_1fr_110px_90px_1fr_auto] gap-3 bg-surface-raised px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-navy/50">
            <span>Document</span>
            <span>Prefix</span>
            <span className="text-right">Next number</span>
            <span className="text-right">Padding</span>
            <span>Preview</span>
            <span />
          </div>
          {(settings ?? []).map((s) => {
            const d = drafts[s.docType] ?? {
              prefix: s.prefix,
              nextNumber: s.nextNumber,
              padding: s.padding,
            };
            const dirty =
              d.prefix !== s.prefix || d.nextNumber !== s.nextNumber || d.padding !== s.padding;
            return (
              <NumberingRow
                key={s.docType}
                docType={s.docType}
                draft={d}
                serverPreview={s.preview}
                dirty={dirty}
                saving={savingType === s.docType}
                onChange={(patch) =>
                  setDrafts((prev) => ({ ...prev, [s.docType]: { ...d, ...patch } }))
                }
                onSave={() => save(s.docType)}
              />
            );
          })}
        </>
      )}
    </div>
  );
}

// ─── Finish setup (spec §5.2: brand-new products awaiting details) ────────────

function FinishSetupRow({ product }: { product: IncompleteProduct }) {
  const { toast } = useToast();
  const completeSetup = useCompleteSetup();
  const [price, setPrice] = React.useState(product.pricePerUnit ?? "");
  const [unitsPerBox, setUnitsPerBox] = React.useState(product.unitsPerBox?.toString() ?? "");
  const [saving, setSaving] = React.useState(false);

  const confirm = () => {
    const data: { pricePerUnit?: number; unitsPerBox?: number } = {};
    const p = parseFloat(price);
    if (Number.isFinite(p)) data.pricePerUnit = p;
    const u = parseInt(unitsPerBox, 10);
    if (Number.isFinite(u) && u >= 1) data.unitsPerBox = u;
    setSaving(true);
    completeSetup.mutate(
      { id: product.id, data },
      {
        onSuccess: () => toast({ title: `${product.name} is set up`, variant: "success" }),
        onError: (e: any) =>
          toast({
            title: "Could not finish setup",
            description: e?.response?.data?.message ?? e.message,
            variant: "error",
          }),
        onSettled: () => setSaving(false),
      },
    );
  };

  return (
    <div className="grid grid-cols-[1fr_110px_90px_auto] items-center gap-3 border-b border-surface-border px-4 py-3 last:border-b-0">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-navy">{product.name}</p>
        <p className="font-mono text-xs text-navy/50">
          {product.sku} · cost {product.standardCost ?? "—"}
        </p>
      </div>
      <label className="flex flex-col text-[10px] font-semibold uppercase tracking-wide text-navy/50">
        Sell price
        <input
          type="number"
          min={0}
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          className="mt-1 rounded-lg border border-surface-border px-2.5 py-1.5 text-sm font-mono text-right text-navy focus:border-brand-400 focus:outline-none"
        />
      </label>
      <label className="flex flex-col text-[10px] font-semibold uppercase tracking-wide text-navy/50">
        Units/box
        <input
          type="number"
          min={1}
          value={unitsPerBox}
          onChange={(e) => setUnitsPerBox(e.target.value)}
          className="mt-1 rounded-lg border border-surface-border px-2.5 py-1.5 text-sm font-mono text-right text-navy focus:border-brand-400 focus:outline-none"
        />
      </label>
      <button
        onClick={confirm}
        disabled={saving}
        className="self-end rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-40 transition-colors"
      >
        {saving ? "Saving…" : "Confirm"}
      </button>
    </div>
  );
}

function FinishSetupCard() {
  const { data: products, isLoading } = useIncompleteProducts();
  // Hide entirely when there is nothing to finish (keeps the import page tidy).
  if (isLoading || !products || products.length === 0) return null;
  return (
    <div className="rounded-xl border border-warning/40 bg-warning-bg/30 overflow-hidden">
      <div className="flex items-start gap-3 border-b border-warning/30 p-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-warning/15 text-warning">
          <ClipboardList className="h-5 w-5" />
        </span>
        <div className="flex-1">
          <p className="font-semibold text-navy">
            Finish setup · {products.length} product{products.length === 1 ? "" : "s"}
          </p>
          <p className="text-xs text-navy/70 mt-0.5 leading-relaxed">
            Products created from scanned invoices with only a name, SKU and cost. They can sell now
            at cost + margin — confirm the sell price and case size to finish them.
          </p>
        </div>
      </div>
      <div className="bg-white">
        {products.map((p) => (
          <FinishSetupRow key={p.id} product={p} />
        ))}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SettingsImportPage() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => {
    setTitle("Import Data");
  }, [setTitle]);

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-navy">Import from Zoho</h1>
        <p className="mt-1 text-sm text-navy/70">
          Upload CSV exports from Zoho to migrate your data into RouteFlow.
        </p>
      </div>

      {/* Recommended order banner */}
      <div className="flex items-start gap-3 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" />
        <div>
          <p className="text-sm font-semibold text-brand-700">
            Import in this order for best results
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1">
            {STEP_LABELS.map((label, i) => (
              <React.Fragment key={label}>
                <span className="inline-flex items-center gap-1.5 text-sm text-brand-700">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-200 text-[11px] font-bold text-brand-800">
                    {i + 1}
                  </span>
                  {label}
                </span>
                {i < STEP_LABELS.length - 1 && (
                  <span className="text-brand-300 text-xs select-none">→</span>
                )}
              </React.Fragment>
            ))}
          </div>
          <p className="mt-2 text-xs text-brand-600">
            Invoices require customers to exist first. Payments require matching invoices.
          </p>
        </div>
      </div>

      {/* Document numbering continuity (spec §1) */}
      <NumberingCard />

      {/* Finish setup — brand-new products from scans awaiting details (spec §5.2) */}
      <FinishSetupCard />

      {/* Import cards — uniform 2-column grid, cards stretch to equal height per row */}
      <div className="grid grid-cols-2 gap-5">
        {IMPORT_SECTIONS.map((section, i) => (
          <ImportCard key={section.id} section={section} step={i + 1} />
        ))}
      </div>
    </div>
  );
}
