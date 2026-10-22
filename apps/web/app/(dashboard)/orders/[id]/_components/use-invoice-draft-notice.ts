"use client";

import * as React from "react";

type InvoiceRef = { invoiceNumber?: string | null; status?: string | null };

/**
 * apple-ux r4 F07: Generate Invoice used to end in silence. The new number appeared as DRAFT, nothing
 * said it had not been sent, no live region announced it, and the button the person had just pressed
 * left the page, dropping focus to BODY.
 *
 * `announce` takes what the create call returned. The sentence is derived while the order's own invoice
 * list still shows that number as a DRAFT (so it stops being true-and-shown the moment the invoice is
 * sent), and the number's element takes focus the first time it exists, whichever of the refetch and the
 * success callback lands first. `focusRef(number)` goes on that element (it needs tabIndex -1).
 */
export function useInvoiceDraftNotice(invoices: InvoiceRef[] | undefined) {
  const [made, setMade] = React.useState<string[]>([]);
  const pendingFocus = React.useRef<string | null>(null);

  const announce = (created: InvoiceRef[] | InvoiceRef | undefined) => {
    const numbers = (Array.isArray(created) ? created : created ? [created] : [])
      .map((i) => i.invoiceNumber)
      .filter((n): n is string => !!n);
    if (numbers.length === 0) return;
    pendingFocus.current = numbers[0];
    setMade(numbers);
  };

  const drafts = made.filter((n) =>
    invoices?.some((i) => i.invoiceNumber === n && i.status === "DRAFT"),
  );
  const message =
    drafts.length === 0
      ? ""
      : drafts.length === 1
        ? `${drafts[0]} created as a draft. Not sent to the customer.`
        : `${drafts.join(", ")} created as drafts. Not sent to the customer.`;

  const focusRef = (invoiceNumber: string) => (el: HTMLElement | null) => {
    if (el && pendingFocus.current === invoiceNumber) {
      pendingFocus.current = null;
      el.focus();
    }
  };

  return { message, announce, focusRef };
}
