"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@routeflow/ui/web";
import { useMayOpenStatement } from "@/lib/api/account-statement";
import { AccountStatementSheet } from "./AccountStatementSheet";

/**
 * SA-1078 U1-U6: the one control on every staff figure that prints an open balance. It opens the one statement sheet for that
 * customer. Without permission, or while the figure itself is unavailable (`unavailable`), it renders the plain figure: no
 * tap, no 403 (U7, U10). Inside a clickable row it stops the click so the row's own action stays on the rest of the row.
 */
export function OpenBalanceButton({
  customerId,
  children,
  unavailable = false,
  linkInvoices = true,
  chevron = false,
  hint,
  className,
  actions,
}: {
  customerId: string | null | undefined;
  children: React.ReactNode;
  unavailable?: boolean;
  linkInvoices?: boolean;
  chevron?: boolean;
  /** A line under the figure that only shows when the figure is a button (e.g. "View statement"). */
  hint?: string;
  className?: string;
  actions?: React.ReactNode;
}) {
  const may = useMayOpenStatement();
  const [open, setOpen] = React.useState(false);
  if (!may || unavailable || !customerId) return <>{children}</>;
  return (
    <>
      <button
        type="button"
        data-testid="open-balance-button"
        aria-haspopup="dialog"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className={cn(
          "inline-flex min-h-[44px] items-center gap-1 rounded text-left underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 sm:min-h-0",
          className,
        )}
      >
        {hint ? (
          <span className="flex flex-col">
            {children}
            <span className="text-xs font-normal text-navy/70">{hint}</span>
          </span>
        ) : (
          children
        )}
        {chevron && <ChevronRight className="h-4 w-4 shrink-0 opacity-60" aria-hidden />}
      </button>
      <AccountStatementSheet
        customerId={customerId}
        open={open}
        onClose={() => setOpen(false)}
        linkInvoices={linkInvoices}
        actions={actions}
      />
    </>
  );
}
