"use client";

import * as React from "react";
import { Download } from "lucide-react";
import { Button, useToast } from "@routeflow/ui/web";
import { apiClient } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { csvFilename, downloadCsvBlob } from "@/lib/export";
import { exportErrorMessage, exportTailWarning, isoDay } from "@/lib/csv-export-request";

export interface ProductsExportFilters {
  search?: string;
  category?: string;
  stockStatus?: "IN_STOCK" | "LOW" | "OUT_OF_STOCK";
  isActive?: boolean;
  /** The list's "Hidden from portal" filter (`false` = hidden only). */
  portalVisible?: boolean;
  section?: string;
}

const PRESETS = [7, 30, 90] as const;
/** A preset of N days is N calendar days inclusive of today: from = today − (N − 1). */
const presetFrom = (days: number) => isoDay(days - 1);

/**
 * "Export CSV (N products)" — the whole filtered catalog (not just the loaded page) as a
 * streamed CSV from GET /products/export.csv, with sales-stat columns for the chosen period.
 * OPERATOR / TENANT_ADMIN only (the endpoint enforces the same).
 */
export function ProductsExportButton({
  total,
  loading = false,
  filters,
}: {
  total: number;
  /** The list query has not answered yet, so `total` is not a real count. */
  loading?: boolean;
  filters: ProductsExportFilters;
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [open, setOpen] = React.useState(false);
  const [from, setFrom] = React.useState(() => presetFrom(30));
  const [to, setTo] = React.useState(() => isoDay(0));
  const [busy, setBusy] = React.useState(false);

  if (user?.role !== "OPERATOR" && user?.role !== "TENANT_ADMIN") return null;

  async function download() {
    if (busy) return;
    if (total === 0) {
      toast({
        title: "Nothing to export",
        description: "No products match the current filters.",
        variant: "info",
      });
      return;
    }
    setBusy(true);
    try {
      const res = await apiClient.get<Blob>("/products/export.csv", {
        params: {
          search: filters.search || undefined,
          category: filters.category || undefined,
          stockStatus: filters.stockStatus || undefined,
          isActive: filters.isActive,
          portalVisible: filters.portalVisible,
          section: filters.section || undefined,
          from,
          to,
        },
        responseType: "blob",
      });
      downloadCsvBlob(csvFilename("products", from, to), res.data);
      setOpen(false);
      if (await exportTailWarning(res.data)) {
        toast({
          title: "Export may be incomplete",
          description: "The file ends early. Check it before relying on it, or narrow the filters.",
          variant: "warning",
        });
      }
    } catch (err) {
      toast({
        title: "Export failed",
        description: await exportErrorMessage(err),
        variant: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <Button
        variant="secondary"
        leftIcon={<Download className="h-4 w-4" />}
        disabled={busy || loading}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-testid="products-export-button"
      >
        Export CSV ({total} {total === 1 ? "product" : "products"})
      </Button>
      {open && (
        <div
          role="dialog"
          aria-label="Export products"
          data-testid="products-export-popover"
          className="absolute left-0 z-30 mt-2 w-[min(20rem,calc(100vw-2rem))] space-y-3 sm:left-auto sm:right-0 rounded-lg border border-slate-200 bg-white p-3 shadow-lg"
        >
          <p className="text-xs text-slate-500">
            Sales stats period (units sold, net sales, last sold date).
          </p>
          <div className="flex gap-1">
            {PRESETS.map((d) => (
              <button
                key={d}
                type="button"
                className="rounded border border-slate-200 px-2 py-1 text-xs hover:bg-slate-50"
                onClick={() => {
                  setFrom(presetFrom(d));
                  setTo(isoDay(0));
                }}
              >
                {d} days
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <label className="space-y-1">
              <span>From</span>
              <input
                type="date"
                value={from}
                max={to}
                onChange={(e) => setFrom(e.target.value)}
                data-testid="products-export-from"
                className="w-full rounded border border-slate-200 px-2 py-1 text-sm"
              />
            </label>
            <label className="space-y-1">
              <span>To</span>
              <input
                type="date"
                value={to}
                min={from}
                onChange={(e) => setTo(e.target.value)}
                data-testid="products-export-to"
                className="w-full rounded border border-slate-200 px-2 py-1 text-sm"
              />
            </label>
          </div>
          <Button
            className="w-full"
            disabled={busy || !from || !to}
            onClick={download}
            data-testid="products-export-download"
          >
            {busy ? "Exporting…" : "Download"}
          </Button>
        </div>
      )}
    </div>
  );
}
