/**
 * #1529 (B87) / SA-517 PR-B: the new-invoice screen's OPT-IN deposit schedule, mirroring web's
 * new-invoice page exactly (apps/web/app/(dashboard)/invoices/new/page.tsx): all-or-nothing — a
 * percent without a due date, or a due date without a positive percent, blocks submit, and only a
 * complete deposit is sent. No tenant/customer default is applied (SA-517 item 3); the 0.01–99.99
 * range is the server's (CreateInvoiceDto), as on web.
 */
export type DepositErrors = { depositPercent?: string; depositDueDate?: string };

export function depositErrors(
  open: boolean,
  percent: number | null,
  dueDate: string,
): DepositErrors {
  const errs: DepositErrors = {};
  if (!open) return errs;
  if (percent != null && percent > 0 && !dueDate) {
    errs.depositDueDate = "Deposit due date is required.";
  }
  if (dueDate && !(percent != null && percent > 0)) {
    errs.depositPercent = "Enter a deposit percentage.";
  }
  return errs;
}

export function depositPayload(
  open: boolean,
  percent: number | null,
  dueDate: string,
): { depositPercent?: number; depositDueDate?: string } {
  return open && percent != null && percent > 0 && dueDate
    ? { depositPercent: percent, depositDueDate: dueDate }
    : {};
}
