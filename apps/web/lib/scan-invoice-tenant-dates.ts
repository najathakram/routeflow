import * as React from "react";
import { useTenantToday } from "@/lib/tenant-timezone";

interface DatedInvoice {
  id: string;
  billDate: string;
  expenseDate: string;
}

/** SA-964 §4 / F14: fills any EMPTY bill or expense date with `day`; a typed date is never touched. */
export function fillEmptyDates<T extends DatedInvoice>(invoices: T[], day: string): T[] {
  return invoices.map((inv) =>
    inv.billDate && inv.expenseDate
      ? inv
      : { ...inv, billDate: inv.billDate || day, expenseDate: inv.expenseDate || day },
  );
}

/**
 * The scan modal's bill and expense dates default to the TENANT's day, never the browser's: a new scanned invoice starts with
 * both empty and is filled ONCE, as soon as the zone is known, for invoices scanned before or after it resolves. Once an invoice
 * has had its fill, a date the user clears stays cleared (the server refuses an empty date and the modal says so).
 */
export function useFillTenantDates<T extends DatedInvoice>(
  invoices: T[],
  invoicesRef: { current: T[] },
  setInvoices: (update: (prev: T[]) => T[]) => void,
): void {
  const tenantToday = useTenantToday();
  const filled = React.useRef(new Set<string>());
  React.useEffect(() => {
    if (!tenantToday) return;
    const fresh = new Set(
      invoicesRef.current.filter((inv) => !filled.current.has(inv.id)).map((inv) => inv.id),
    );
    if (fresh.size === 0) return;
    for (const id of fresh) filled.current.add(id);
    setInvoices((prev) =>
      prev.map((inv) => (fresh.has(inv.id) ? fillEmptyDates([inv], tenantToday)[0]! : inv)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantToday, invoices]);
}
