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
  Building2,
} from "lucide-react";
import { cn } from "@routeflow/ui/web";

interface ImportResult {
  imported?: number;
  updated?: number;
  created?: number;
  skipped: number;
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
    description: "Sync current stock quantities from Zoho Stock Summary Report",
    endpoint: "/import/inventory",
    icon: BarChart3,
    color: "text-teal-500 bg-teal-50",
    zohoExportPath: "Zoho Inventory → Reports → Stock Summary → Export",
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
    description: "Import expense records from Zoho Expense CSV export. Suppliers are auto-created from vendor names.",
    endpoint: "/import/expenses",
    icon: Receipt,
    color: "text-danger bg-danger-bg",
    zohoExportPath: "Zoho Expense → My Expenses → Export",
  },
  {
    id: "suppliers",
    label: "Suppliers",
    description: "Import suppliers from a Zoho Expense CSV — creates/updates supplier records from the vendor names",
    endpoint: "/import/expense-suppliers",
    icon: Building2,
    color: "text-purple-500 bg-purple-50",
    zohoExportPath: "Zoho Expense → My Expenses → Export (same file as Expenses)",
  },
];

function ImportCard({ section }: { section: ImportSection }) {
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
      let summary = d.updated !== undefined
        ? `${d.updated} updated, ${d.created} created, ${d.skipped} skipped`
        : `${d.imported} records imported, ${d.skipped} skipped`;
      if (d.suppliersCreated || d.suppliersUpdated) {
        const supplierParts: string[] = [];
        if (d.suppliersCreated) supplierParts.push(`${d.suppliersCreated} supplier${d.suppliersCreated !== 1 ? "s" : ""} created`);
        if (d.suppliersUpdated) supplierParts.push(`${d.suppliersUpdated} supplier${d.suppliersUpdated !== 1 ? "s" : ""} matched`);
        summary += ` · ${supplierParts.join(", ")}`;
      }
      toast({
        title: `${section.label} imported`,
        description: summary,
        variant: "success",
      });
    } catch (err: any) {
      toast({
        title: "Import failed",
        description:
          err?.response?.data?.message ??
          "Please check your file format and try again",
        variant: "error",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-xl border border-surface-border bg-white overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-surface-border p-4">
        <span
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
            section.color,
          )}
        >
          <Icon className="h-5 w-5" />
        </span>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-navy">{section.label}</p>
          <p className="text-xs text-navy/60">{section.description}</p>
        </div>
        {result && (
          <div className="flex items-center gap-1.5 text-xs shrink-0">
            <span className="flex items-center gap-1 text-success">
              <CheckCircle2 className="h-3.5 w-3.5" />
              {result.updated !== undefined
                ? `${result.updated} updated, ${result.created} created`
                : `${result.imported} imported`}
            </span>
            {result.skipped > 0 && (
              <span className="flex items-center gap-1 text-warning ml-2">
                <AlertCircle className="h-3.5 w-3.5" />
                {result.skipped} skipped
              </span>
            )}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="p-4 space-y-3">
        {/* Export hint */}
        <div className="flex items-start gap-2 rounded-lg bg-surface-raised px-3 py-2 text-xs text-navy/60">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-navy/40" />
          <span>
            <strong className="text-navy/70">How to export:</strong>{" "}
            {section.zohoExportPath}
          </span>
        </div>

        {/* Drop zone */}
        <div
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          onClick={() => inputRef.current?.click()}
          className={cn(
            "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 cursor-pointer transition-colors",
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
          <Upload
            className={cn("h-6 w-6", file ? "text-brand-500" : "text-navy/30")}
          />
          {file ? (
            <div className="text-center">
              <p className="text-sm font-medium text-brand-600">{file.name}</p>
              <p className="text-xs text-navy/40">
                {(file.size / 1024).toFixed(1)} KB · Click to change
              </p>
            </div>
          ) : (
            <div className="text-center">
              <p className="text-sm text-navy/60">
                Drop CSV file here or{" "}
                <span className="text-brand-500">browse</span>
              </p>
              <p className="text-xs text-navy/40 mt-0.5">
                Zoho CSV export format
              </p>
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
              Importing... (this may take a moment)
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
                {result.errors.length} error
                {result.errors.length > 1 ? "s" : ""} during import
              </span>
              {showErrors ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
            </button>
            {showErrors && (
              <ul className="mt-2 space-y-0.5 text-xs text-navy/60 max-h-32 overflow-y-auto">
                {result.errors.slice(0, 20).map((e, i) => (
                  <li key={i} className="truncate">
                    • {e}
                  </li>
                ))}
                {result.errors.length > 20 && (
                  <li className="text-navy/40">
                    ...and {result.errors.length - 20} more
                  </li>
                )}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ProductImportCard() {
  const { toast } = useToast();
  const [file, setFile] = React.useState<File | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [result, setResult] = React.useState<ImportResult | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
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
      const res = await apiClient.post("/import/products", formData, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 120_000,
      });
      setResult(res.data);
      toast({
        title: "Products imported",
        description: `${res.data.imported} products imported`,
        variant: "success",
      });
    } catch (err: any) {
      toast({
        title: "Import failed",
        description:
          err?.response?.data?.message ?? "Check file format",
        variant: "error",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <input
        ref={inputRef}
        type="file"
        accept=".csv"
        className="hidden"
        onChange={handleFileChange}
      />
      <button
        onClick={() => inputRef.current?.click()}
        className="rounded-lg border border-surface-border px-3 py-1.5 text-sm text-navy/60 hover:bg-surface-raised transition-colors"
      >
        {file ? file.name : "Choose Zoho Items CSV..."}
      </button>
      <button
        onClick={handleImport}
        disabled={!file || loading}
        className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 hover:bg-brand-600 transition-colors"
      >
        {loading ? "Importing..." : "Import Products"}
      </button>
      {result && (
        <span className="text-xs text-success">
          {result.imported} imported
        </span>
      )}
    </div>
  );
}

export default function SettingsImportPage() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => {
    setTitle("Import Data");
  }, [setTitle]);

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold text-navy">Import from Zoho</h1>
        <p className="mt-1 text-sm text-navy/60">
          Import your data from Zoho Invoices exports. Follow the order below
          for best results:{" "}
          <strong className="text-navy">
            Customers → Invoices → Payments → Expenses
          </strong>
        </p>
      </div>

      {/* Order guidance */}
      <div className="flex items-center gap-3 rounded-xl bg-brand-50 border border-brand-200 px-4 py-3">
        <AlertCircle className="h-4 w-4 text-brand-500 shrink-0" />
        <p className="text-sm text-brand-700">
          <strong>Recommended import order:</strong> Import Customers first,
          then Invoices, then Payments. Payments require matching invoices to
          already exist.
        </p>
      </div>

      {/* Import cards - 2 column grid */}
      <div className="grid grid-cols-2 gap-5">
        {IMPORT_SECTIONS.map((section) => (
          <ImportCard key={section.id} section={section} />
        ))}
      </div>

      {/* Products section */}
      <div className="rounded-xl border border-surface-border bg-white p-4">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-purple-50 text-purple-500 shrink-0">
            <Package className="h-4 w-4" />
          </span>
          <div className="flex-1">
            <p className="font-medium text-navy">Products / Inventory Items</p>
            <p className="mt-0.5 text-sm text-navy/60">
              Export your Items list from Zoho Invoices → Items → Export, then
              import below.
            </p>
            <div className="mt-3">
              <ProductImportCard />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
