"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@routeflow/ui/web";
import {
  buyerAccountStatementKey,
  fetchBuyerAccountStatementPdfUrl,
  useBuyerAccountStatement,
} from "@/lib/api/buyer";
import { buyerApiClient } from "@/lib/buyer-api-client";
import { StatementSheetFrame } from "./AccountStatementSheet";
import { StatementPrintControl } from "./StatementPrintButton";

/**
 * SA-1078 W-1096 PR-6 BP1/BP2: the buyer portal's open balance, the twin of `OpenBalanceButton`. Tapping the figure opens
 * the same statement sheet over `GET /buyer/account-statement`. The buyer's actions are Print only (no Email), invoice
 * numbers are plain text (a buyer has no staff invoice page to land on), and nothing here touches the staff client.
 */
function BuyerStatementSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const q = useBuyerAccountStatement(open);
  // A sheet that read a fresher figure leaves the Outstanding card behind it fresh too, and the next open reads again.
  const qc = useQueryClient();
  const loaded = React.useRef(false);
  React.useEffect(() => {
    if (open && q.data) loaded.current = true;
  }, [open, q.data]);
  React.useEffect(() => {
    if (open || !loaded.current) return;
    loaded.current = false;
    void qc.invalidateQueries({
      queryKey: buyerAccountStatementKey.slice(0, 2),
      predicate: (query) => query.queryKey[2] !== buyerAccountStatementKey[2],
    });
    qc.removeQueries({ queryKey: buyerAccountStatementKey });
  }, [open, qc]);
  return (
    <StatementSheetFrame
      open={open}
      onClose={onClose}
      query={q}
      linkInvoices={false}
      footer={
        <StatementPrintControl getUrl={fetchBuyerAccountStatementPdfUrl} client={buyerApiClient} />
      }
    />
  );
}

export function BuyerOpenBalanceButton({
  children,
  hint,
  className,
}: {
  children: React.ReactNode;
  /** A line under the figure, e.g. "View statement". */
  hint?: string;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button
        type="button"
        data-testid="open-balance-button"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex min-h-[44px] flex-col items-start justify-center rounded text-left underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-buyer-500 sm:min-h-0",
          className,
        )}
      >
        {children}
        {hint ? <span className="text-xs font-normal text-navy/70">{hint}</span> : null}
      </button>
      <BuyerStatementSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}
