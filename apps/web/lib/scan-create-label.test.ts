import { scanCreateLabel } from "./scan-create-label";

const base = {
  invoiceCount: 1,
  createMode: "bill" as const,
  creatableBills: 1,
  creatableExpenses: 0,
  creatablePos: 1,
};

describe("scanCreateLabel", () => {
  it("bill intent: the three single-invoice labels (unchanged)", () => {
    expect(scanCreateLabel({ ...base, intent: "bill" })).toBe("Create Vendor Bill");
    expect(scanCreateLabel({ ...base, intent: "bill", createMode: "expense" })).toBe(
      "Record Expense",
    );
    expect(scanCreateLabel({ ...base, intent: "bill", createMode: "both" })).toBe(
      "Create Bill & Expense",
    );
  });

  it("bill intent, several invoices: counts bills and expenses, falls back to bills", () => {
    expect(
      scanCreateLabel({
        ...base,
        intent: "bill",
        invoiceCount: 3,
        creatableBills: 2,
        creatableExpenses: 1,
      }),
    ).toBe("Create 2 bills + 1 expense");
    expect(
      scanCreateLabel({
        ...base,
        intent: "bill",
        invoiceCount: 3,
        creatableBills: 0,
        creatableExpenses: 0,
      }),
    ).toBe("Create bills");
  });

  it("purchase-order intent names a PO and counts only invoices that will raise one", () => {
    expect(scanCreateLabel({ ...base, intent: "purchase-order" })).toBe("Create purchase order");
    expect(
      scanCreateLabel({ ...base, intent: "purchase-order", invoiceCount: 3, creatablePos: 2 }),
    ).toBe("Create 2 purchase orders");
    expect(
      scanCreateLabel({ ...base, intent: "purchase-order", invoiceCount: 3, creatablePos: 1 }),
    ).toBe("Create 1 purchase order");
    expect(
      scanCreateLabel({ ...base, intent: "purchase-order", invoiceCount: 3, creatablePos: 0 }),
    ).toBe("Create purchase orders");
  });
});
