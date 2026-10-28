"use client";

import * as React from "react";
import { useOptionalToast } from "@routeflow/ui/web";
import { apiClient } from "@/lib/api-client";
import { fetchPdfBlob } from "@/lib/fetch-pdf-blob";
import { printPdfBlob } from "@/lib/print-pdf-blob";
import type { InvoicePdfVariant } from "@/lib/api/invoices";

/**
 * SA-1026 B: the ONE way a screen prints an invoice. It asks for the same Letter PDF the invoice page prints
 * (GET /invoices/:id/pdf, then the shared fetch that attaches the sign-in only to our own storage), and hands each one to
 * the shared iframe print, in the order given. Every PDF is fetched BEFORE the first one prints, so a failure prints nothing
 * and says so (one toast), never half an order.
 *
 * Concurrent calls are independent (the invoices list prints row A and row B at once), so there is no shared lock: `printing`
 * is true while any call is running, and a caller that needs a per-row spinner keeps its own.
 */
export function usePrintInvoice() {
  const toast = useOptionalToast()?.toast; // no provider (a bare test render): the failure is simply silent
  const [running, setRunning] = React.useState(0);

  const print = React.useCallback(
    async (
      ids: string | readonly string[],
      opts?: { variant?: InvoicePdfVariant },
    ): Promise<boolean> => {
      const list = typeof ids === "string" ? [ids] : [...ids];
      if (list.length === 0) return false;
      setRunning((n) => n + 1);
      try {
        const blobs: Blob[] = [];
        for (const id of list) {
          const { url } = await apiClient
            .get<{ url: string }>(`/invoices/${id}/pdf`, {
              params: opts?.variant ? { variant: opts.variant } : undefined,
            })
            .then((r) => r.data);
          if (!url) throw new Error("No PDF URL returned");
          blobs.push(await fetchPdfBlob(url, apiClient));
        }
        for (const blob of blobs) printPdfBlob(blob);
        return true;
      } catch {
        toast?.({
          title: "Could not print the invoice",
          description: "Try again.",
          variant: "error",
        });
        return false;
      } finally {
        setRunning((n) => n - 1);
      }
    },
    [toast],
  );

  return { print, printing: running > 0 };
}
