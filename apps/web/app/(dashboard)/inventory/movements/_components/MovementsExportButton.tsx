"use client";

import * as React from "react";
import { Download } from "lucide-react";
import { Button, useToast } from "@routeflow/ui/web";
import { apiClient } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { csvFilename, downloadCsvBlob } from "@/lib/export";
import { exportTailWarning } from "@/lib/csv-export-request";

export interface MovementsExportFilters {
  productId?: string;
  type?: string;
  from?: string;
  to?: string;
}

const EMPTY_TIP = "Nothing to export — no movements match these filters";

/**
 * "Export" for the stock-movements list — `GET /inventory/movements/export.csv` with the list's own
 * filters (never the page), streamed by the server and saved via lib/export. Disabled with a tooltip
 * when nothing matches. OPERATOR / TENANT_ADMIN only (the endpoint refuses DRIVER). Any failure is
 * one fixed toast; a file the server ended early still downloads, with a warning.
 */
export function MovementsExportButton({
  total,
  loading = false,
  filters,
}: {
  total: number;
  /** The list has not answered yet, so `total` is not a real count. */
  loading?: boolean;
  filters: MovementsExportFilters;
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [busy, setBusy] = React.useState(false);

  if (user?.role !== "OPERATOR" && user?.role !== "TENANT_ADMIN") return null;

  const empty = !loading && total === 0;

  async function download() {
    if (busy || empty || loading) return;
    setBusy(true);
    try {
      const res = await apiClient.get<Blob>("/inventory/movements/export.csv", {
        params: {
          productId: filters.productId || undefined,
          type: filters.type || undefined,
          from: filters.from || undefined,
          to: filters.to || undefined,
        },
        responseType: "blob",
      });
      downloadCsvBlob(csvFilename("inventory-movements", filters.from, filters.to), res.data);
      if (await exportTailWarning(res.data)) {
        toast({
          title: "Export may be incomplete",
          description: "The file ends early. Check it before relying on it, or narrow the filters.",
          variant: "warning",
        });
      }
    } catch {
      toast({ title: "Export failed, please try again", variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      variant="secondary"
      size="sm"
      leftIcon={<Download className="h-4 w-4" />}
      disabled={busy || loading || empty}
      title={empty ? EMPTY_TIP : undefined}
      onClick={download}
      data-testid="movements-export-button"
    >
      {busy ? "Exporting…" : "Export"}
    </Button>
  );
}
