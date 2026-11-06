"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@routeflow/ui/web";
import { useMayOpenStatement } from "@/lib/api/account-statement";
import { AccountStatementSheet } from "./AccountStatementSheet";

/** F02: an open sheet is in the URL as `?statement=<customerId>`, so a reload brings it back (the `?newFamily=1` pattern). */
const STATEMENT_PARAM = "statement";

/** Same page, same history state (the back-to-close mark lives there), one query param set or dropped; no entry added. */
function writeStatementParam(customerId: string | null) {
  const url = new URL(window.location.href);
  if (url.searchParams.get(STATEMENT_PARAM) === customerId) return;
  if (customerId === null) url.searchParams.delete(STATEMENT_PARAM);
  else url.searchParams.set(STATEMENT_PARAM, customerId);
  window.history.replaceState({ ...window.history.state }, "", url);
}

/**
 * W-1117: for a screen that lists the figures a page at a time. `?statement=<id>` names a customer whose figure may not be on
 * the page a reload or a pasted link lands on (the page number is in the URL; sort and page size are not). Nothing then
 * takes the param, and it used to sit there until that customer's row arrived by a page change or a sort, and the sheet
 * opened with nobody tapping. Pass the ids of the rows on screen once they are loaded (undefined while loading): a param
 * no row took is dropped. Child effects run before this one, so a figure that is on the page has already taken it; and
 * nothing is dropped before the permission is known, because the figures render plain until then and take it after.
 */
export function useDropStatementParamNotOnPage(rowIds: readonly string[] | undefined) {
  const may = useMayOpenStatement();
  React.useEffect(() => {
    if (!may || !rowIds) return;
    const id = new URL(window.location.href).searchParams.get(STATEMENT_PARAM);
    if (id && !rowIds.includes(id)) writeStatementParam(null);
  }, [may, rowIds]);
}

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
}: {
  customerId: string | null | undefined;
  children: React.ReactNode;
  unavailable?: boolean;
  linkInvoices?: boolean;
  chevron?: boolean;
  /** A line under the figure that only shows when the figure is a button (e.g. "View statement"). */
  hint?: string;
  className?: string;
}) {
  const may = useMayOpenStatement();
  const [open, setOpen] = React.useState(false);
  const live = may && !unavailable && !!customerId;
  // F02: a reload with the sheet open comes back open. The first figure for that customer takes the param and drops it, so
  // a second figure for the same customer finds nothing to take, and the reloaded entry goes clean: opening pushes its own
  // entry and puts the param back on that one.
  React.useEffect(() => {
    if (!live || !customerId) return;
    if (new URL(window.location.href).searchParams.get(STATEMENT_PARAM) !== customerId) return;
    writeStatementParam(null);
    setOpen(true);
  }, [live, customerId]);
  // The sheet's own effect (a child) pushes its history entry first; the param then goes on that entry, so Back lands on a clean URL.
  React.useEffect(() => {
    if (!open || !customerId) return;
    writeStatementParam(customerId);
    return () => writeStatementParam(null);
  }, [open, customerId]);
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
      />
    </>
  );
}
