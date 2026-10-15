"use client";

import * as React from "react";
import { Download } from "lucide-react";
import { Button, useToast } from "@routeflow/ui/web";
import { apiClient } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { useProductSales } from "@/lib/api/product-sales";
import { usePlanFlag } from "@/lib/api/plan-flags";
import { planFlagVisible } from "@/lib/plan-gated-nav";
import { csvFilename, downloadCsvBlob } from "@/lib/export";
import {
  exportErrorMessage,
  exportTailWarning,
  filenameFromDisposition,
} from "@/lib/csv-export-request";

/**
 * "Download product sales CSV" — GET /analytics/products/:id/insights.csv (the sales lines
 * behind the Demand / Sales cards). Hidden for roles the endpoint refuses and for a plan
 * without flag.analytics (the same gate the endpoint enforces), never a broken button.
 */
export function ProductInsightsExport({ productId, sku }: { productId: string; sku: string }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const analytics = usePlanFlag("flag.analytics");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  // J10: nothing to export for a product that never sold. Same query key as the Sales card (shared
  // cache); hidden while loading (no flash), shown if the lookup failed (never lose the export).
  const sales = useProductSales(productId);
  const neverSold = sales.isLoading || (!!sales.data && sales.data.summary.count === 0);

  const roleOk = user?.role === "OPERATOR" || user?.role === "TENANT_ADMIN";
  if (!roleOk || !planFlagVisible(analytics) || neverSold) return null;

  async function download() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await apiClient.get<Blob>(`/analytics/products/${productId}/insights.csv`, {
        params: { from: from || undefined, to: to || undefined },
        responseType: "blob",
      });
      const name =
        filenameFromDisposition(res.headers?.["content-disposition"]) ??
        csvFilename(`product-sales-${sku}`, from || null, to || null);
      downloadCsvBlob(name, res.data);
      if (await exportTailWarning(res.data)) {
        toast({
          title: "Export may be incomplete",
          description: "The file ends early. Check it before relying on it, or narrow the dates.",
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
    <div className="flex flex-wrap items-end gap-2 text-xs" data-testid="product-insights-export">
      <label className="space-y-1">
        <span>From</span>
        <input
          type="date"
          value={from}
          max={to || undefined}
          onChange={(e) => setFrom(e.target.value)}
          data-testid="product-insights-export-from"
          className="block w-40 rounded border border-slate-200 px-2 py-1 text-sm"
        />
      </label>
      <label className="space-y-1">
        <span>To</span>
        <input
          type="date"
          value={to}
          min={from || undefined}
          onChange={(e) => setTo(e.target.value)}
          data-testid="product-insights-export-to"
          className="block w-40 rounded border border-slate-200 px-2 py-1 text-sm"
        />
      </label>
      <Button
        variant="secondary"
        leftIcon={<Download className="h-4 w-4" />}
        disabled={busy}
        onClick={download}
        data-testid="product-insights-export-button"
      >
        {busy ? "Exporting…" : "Download product sales CSV"}
      </Button>
    </div>
  );
}
