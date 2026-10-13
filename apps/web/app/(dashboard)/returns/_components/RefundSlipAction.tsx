"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@routeflow/ui/web";
import { apiClient } from "@/lib/api-client";
import { useOptionalAuth } from "@/lib/auth-context";
import { useReturn } from "@/lib/api/returns";
import { useTenant } from "@/components/tenant-provider";
import { buildRefundSlip, type RefundSlipProfile } from "@/lib/refund-slip";
import { RefundSlipView } from "./RefundSlipView";

/**
 * "Print slip" for a refunded return (the Return page), optionally printing by itself once (after a refund confirms). The
 * slip is built from GET /returns/:id and printed from a portal that is a direct child of <body>; while it prints,
 * `body.refund-slip-open` (app/shell.css) hides everything else, so the page behind never lands on the 80 mm slip.
 * Nothing is rendered on screen except the button.
 */
/** A browser that never fires `afterprint` still gets the print scope cleaned up. */
const PRINT_FALLBACK_MS = 60_000;

export function RefundSlipAction({
  returnId,
  autoPrint = false,
  className,
}: {
  returnId: string;
  /** Print once, by itself, as soon as the refunded return is loaded (the refund was just confirmed). */
  autoPrint?: boolean;
  className?: string;
}) {
  const { data: ret, isLoading } = useReturn(returnId);
  const { branding } = useTenant();
  const cashier = useOptionalAuth()?.user?.username ?? null;
  const { data: settings } = useQuery<RefundSlipProfile>({
    queryKey: ["settings"],
    queryFn: () => apiClient.get("/settings").then((r) => r.data),
  });
  const [printing, setPrinting] = React.useState(false);
  const reasonId = React.useId();
  const autoPrinted = React.useRef(false);

  const model = React.useMemo(
    () =>
      ret
        ? buildRefundSlip({
            ret,
            printedBy: cashier,
            profile: {
              ...settings,
              businessName: branding?.businessName || settings?.businessName,
            },
          })
        : null,
    [ret, settings, branding?.businessName, cashier],
  );
  const printable = !!model && model.payout.kind !== "NONE";

  React.useEffect(() => {
    if (!printing) return;
    document.body.classList.add("refund-slip-open");
    let fallback: number | undefined;
    const done = () => {
      window.removeEventListener("afterprint", done);
      if (fallback !== undefined) window.clearTimeout(fallback);
      setPrinting(false);
    };
    // one frame so the portal is in the DOM before the browser lays the page out for print
    const raf = window.requestAnimationFrame(() => {
      // print() does NOT block on iOS Safari / Android Chrome: the slip must outlive the call, so clean up when the browser
      // says the print is over, with a fallback for a browser that never says so
      window.addEventListener("afterprint", done, { once: true });
      fallback = window.setTimeout(done, PRINT_FALLBACK_MS);
      window.print();
    });
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("afterprint", done);
      if (fallback !== undefined) window.clearTimeout(fallback);
      document.body.classList.remove("refund-slip-open");
    };
  }, [printing]);

  React.useEffect(() => {
    // auto-print only for a COUNTER sale's refund: the order page and any other surface never print by themselves
    if (autoPrint && printable && ret?.order?.counterSale && !autoPrinted.current) {
      autoPrinted.current = true;
      setPrinting(true);
    }
  }, [autoPrint, printable, ret?.order?.counterSale]);

  if (!isLoading && !printable) return null;
  // Row 330c: a disabled button always says why. Only two states are visible: the refund is still loading, or the
  // slip is with the printer (until `afterprint`, or the fallback timer).
  const reason = printing
    ? "Sending the slip to the printer…"
    : !printable
      ? "Loading the refund…"
      : null;
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        className={className ?? "min-h-11"}
        disabled={!printable || printing}
        aria-describedby={reason ? reasonId : undefined}
        onClick={() => setPrinting(true)}
      >
        Print slip
      </Button>
      {reason && (
        <span
          id={reasonId}
          data-testid="print-slip-reason"
          role="status"
          className="text-xs text-navy/70"
        >
          {reason}
        </span>
      )}
      {printing && model
        ? createPortal(
            <div data-refund-slip-portal className="hidden print:block">
              <RefundSlipView model={model} logoUrl={branding?.logoUrl ?? null} />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
