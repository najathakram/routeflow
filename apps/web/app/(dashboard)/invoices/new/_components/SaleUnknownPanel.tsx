"use client";

import * as React from "react";
import Link from "next/link";
import { Button, Modal } from "@routeflow/ui/web";
import {
  SALE_RECOVERY_COPY as COPY,
  saleRecovery,
  saleRecoveryBody,
  type UnknownSale,
} from "@routeflow/types/sale-attempt";

/**
 * Row 485: shown while a New sale's outcome is UNKNOWN (a 5xx, a dropped connection, or an error that names a
 * committed order or invoice). The cart is locked behind it. The clerk can try again (the SAME Idempotency-Key),
 * open what exists (or the recent orders), or start a new sale, which needs a confirm that points at recent
 * orders first. Copy comes from the shared module so web and mobile cannot diverge.
 */
export function SaleUnknownPanel({
  unknown,
  busy,
  onTryAgain,
  onStartNew,
}: {
  unknown: UnknownSale;
  busy: boolean;
  onTryAgain: () => void;
  onStartNew: () => void;
}) {
  const [confirming, setConfirming] = React.useState(false);
  const recovery = saleRecovery(unknown);
  const ref = React.useRef<HTMLDivElement>(null);
  // The clerk must SEE this: bring the panel into view and put focus on Try again (after the form behind it
  // disabled, which drops focus from whatever field they were in). Runs again if a retry fails and replaces it.
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollIntoView?.({ block: "center" });
    el.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [unknown]);
  return (
    <div
      ref={ref}
      role="alert"
      data-testid="sale-unknown"
      className="mx-6 mt-6 space-y-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm"
    >
      <p className="font-semibold">{COPY.title}</p>
      <p>{saleRecoveryBody(unknown)}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button className="min-h-[44px]" onClick={onTryAgain} disabled={busy}>
          {COPY.tryAgain}
        </Button>
        {recovery.kind === "invoice" ? (
          <Link
            href={`/invoices/${recovery.id}`}
            className="inline-flex min-h-[44px] items-center text-brand-700 underline"
          >
            {COPY.openInvoice}
          </Link>
        ) : recovery.kind === "order" ? (
          <Link
            href={`/orders/${recovery.id}`}
            className="inline-flex min-h-[44px] items-center text-brand-700 underline"
          >
            {COPY.openOrder}
          </Link>
        ) : (
          <Link
            href="/orders"
            className="inline-flex min-h-[44px] items-center text-brand-700 underline"
          >
            {COPY.recentOrders}
          </Link>
        )}
        <Button
          className="min-h-[44px]"
          variant="secondary"
          onClick={() => setConfirming(true)}
          disabled={busy}
        >
          {COPY.startNew}
        </Button>
      </div>
      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={COPY.confirmTitle}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              {COPY.confirmKeep}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirming(false);
                onStartNew();
              }}
            >
              {COPY.startNew}
            </Button>
          </>
        }
      >
        <p className="text-sm">{COPY.confirmBody}</p>
        <p className="mt-2 text-sm">
          <Link href="/orders" className="text-brand-700 underline">
            {COPY.recentOrders}
          </Link>
        </p>
      </Modal>
    </div>
  );
}
