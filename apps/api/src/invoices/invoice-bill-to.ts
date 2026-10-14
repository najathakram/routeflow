/**
 * The ONE ordering of a customer's addresses for the invoice's bill-to: the default first, then oldest, then id, so two
 * defaults (or none) never make the choice depend on row order. The PDF (`invoice-pdf.service.ts`) and the send-state
 * fingerprint (`invoice-send-state.ts`) both read the customer's addresses with this order and pick the first, so the
 * fingerprint covers exactly the address the PDF prints (#2088).
 */
export const BILL_TO_ADDRESS_ORDER = [
  { isDefault: "desc" as const },
  { createdAt: "asc" as const },
  { id: "asc" as const },
];
