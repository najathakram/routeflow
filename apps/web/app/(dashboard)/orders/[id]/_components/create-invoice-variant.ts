/**
 * The Create invoice button's weight in the order panel. One filled primary leads the page: while PENDING that is Confirm
 * Order (apple-ux r3 Q16), so invoicing is secondary until the order is confirmed; while editing it is secondary too.
 * SA-1066 M2: a Ready POS order's one primary is Hand over, so Create invoice is secondary there as well.
 */
export function createInvoiceVariant(
  status: string,
  isEditing: boolean,
  isPos: boolean,
): "primary" | "secondary" {
  if (status === "PENDING" || isEditing) return "secondary";
  return isPos && status === "OUT_FOR_DELIVERY" ? "secondary" : "primary";
}
