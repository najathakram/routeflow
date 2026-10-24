"use client";

import * as React from "react";
import { Download } from "lucide-react";
import { Button, useToast } from "@routeflow/ui/web";
import { apiClient } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { isAccountAdmin } from "@/lib/auth";
import { downloadJsonFile, jsonExportFilename } from "@/lib/json-export";

/**
 * "Download billing data (JSON)" — `GET /billing/export` (subscription, usage, billing events,
 * invoices). The endpoint answers JSON and keeps working while the workspace is READ_ONLY, so this
 * never depends on plan state. Account admins only (the endpoint's own gate). Any failure is
 * one fixed toast: the server text is never shown.
 */
export function BillingExportButton() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [busy, setBusy] = React.useState(false);

  if (!isAccountAdmin(user)) return null;

  async function download() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await apiClient.get("/billing/export");
      downloadJsonFile(
        jsonExportFilename(
          "billing",
          (res.headers as Record<string, unknown> | undefined)?.["content-disposition"],
        ),
        res.data,
      );
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
      disabled={busy}
      onClick={download}
    >
      {busy ? "Exporting…" : "Download billing data (JSON)"}
    </Button>
  );
}
