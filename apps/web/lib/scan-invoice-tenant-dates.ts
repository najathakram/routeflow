import * as React from "react";
import { useTenantToday } from "@/lib/tenant-timezone";

interface DatedInvoice {
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
 * both empty and any empty one is filled as soon as the zone is known, for invoices scanned before or after it resolves.
 */
export function useFillTenantDates<T extends DatedInvoice>(
  invoices: T[],
  invoicesRef: { current: T[] },
  setInvoices: (update: (prev: T[]) => T[]) => void,
): void {
  const tenantToday = useTenantToday();
  React.useEffect(() => {
    if (!tenantToday) return;
    if (!invoicesRef.current.some((inv) => !inv.billDate || !inv.expenseDate)) return;
    setInvoices((prev) => fillEmptyDates(prev, tenantToday));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantToday, invoices]);
}
