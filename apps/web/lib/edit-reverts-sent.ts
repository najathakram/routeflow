/**
 * B1372 (SA-1177 K2, owner box Q2 "Warn, re-send at hand-over"): the confirm before an items edit turns an invoice that was
 * already sent back into a draft. The numbers are the order read's `editRevertsSentInvoices` (the edit's own revert set,
 * computed by the server); nothing here re-derives which invoices revert. Pure, so the page and its test cannot drift.
 */
export const EDIT_REVERTS_SENT_TITLE = "Invoice already sent";
export const EDIT_REVERTS_SENT_CONFIRM = "Edit anyway";

export function editRevertsSentCopy(numbers: readonly string[] | null | undefined): string | null {
  const list = (numbers ?? []).filter(Boolean);
  if (list.length === 0) return null;
  if (list.length === 1) {
    return (
      `Invoice ${list[0]} was already sent. This edit turns it back into a draft. ` +
      "It is sent again when the order is handed over or delivered."
    );
  }
  const names = `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
  return (
    `Invoices ${names} were already sent. This edit turns them back into drafts. ` +
    "They are sent again when the order is handed over or delivered."
  );
}
