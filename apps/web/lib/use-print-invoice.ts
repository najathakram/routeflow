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
 * A browser can swallow `print()` without throwing and without opening a dialog (nothing for the shared print to detect),
 * and a tab opened after an async fetch can be refused by the popup blocker. So every printed PDF also raises a toast with an
 * "Open PDF" action: a fresh click, so the tab is allowed, and it needs no detection of success.
 *
 * Concurrent calls are independent (the invoices list prints row A and row B at once), so there is no shared lock: `printing`
 * is true while any call is running, and a caller that needs a per-row spinner keeps its own.
 */
/** How long the "Open PDF" link stays usable: the toast's own time, plus a margin for a slow reader. */
const OPEN_PDF_TOAST_MS = 15_000;
const OPEN_PDF_URL_MS = 5 * 60_000;

type ToastFn = NonNullable<ReturnType<typeof useOptionalToast>>["toast"];

/**
 * The way out for a print that silently did nothing. Best effort and AFTER every PDF was handed to the printer: a missing
 * toast provider or a browser without object URLs must never stop (or fail) the printing itself.
 */
function offerOpenPdf(toast: ToastFn | undefined, blob: Blob, index: number, total: number): void {
  if (!toast) return;
  try {
    // A URL of its own: the print helper revokes its own after a minute, and this one outlives the toast.
    const openUrl = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(openUrl), OPEN_PDF_URL_MS);
    toast({
      title: total > 1 ? `Sent to the printer (${index + 1} of ${total})` : "Sent to the printer",
      description: "Nothing printed? Open the PDF and print it from there.",
      variant: "info",
      duration: OPEN_PDF_TOAST_MS,
      action: { label: "Open PDF", onClick: () => void window.open(openUrl, "_blank") },
    });
  } catch {
    // no link: the print above already ran
  }
}

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
        blobs.forEach((blob, i) => offerOpenPdf(toast, blob, i, blobs.length));
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
