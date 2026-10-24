/** The footer button of the invoice scanner. In purchase-order intent it names a purchase order and
 *  counts only the invoices that will actually raise one; otherwise it names bills / expenses. */
export function scanCreateLabel(o: {
  intent: "bill" | "purchase-order";
  invoiceCount: number;
  createMode: "bill" | "expense" | "both";
  creatableBills: number;
  creatableExpenses: number;
  creatablePos: number;
}): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (o.intent === "purchase-order") {
    if (o.invoiceCount <= 1) return "Create purchase order";
    return o.creatablePos > 0
      ? `Create ${plural(o.creatablePos, "purchase order")}`
      : "Create purchase orders";
  }
  if (o.invoiceCount <= 1) {
    return o.createMode === "bill"
      ? "Create Vendor Bill"
      : o.createMode === "expense"
        ? "Record Expense"
        : "Create Bill & Expense";
  }
  return (
    "Create " +
    ([
      o.creatableBills > 0 ? plural(o.creatableBills, "bill") : "",
      o.creatableExpenses > 0 ? plural(o.creatableExpenses, "expense") : "",
    ]
      .filter(Boolean)
      .join(" + ") || "bills")
  );
}
