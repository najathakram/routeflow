import { invoiceListStatusParams } from "./invoice-list-filter";

/**
 * R4 (SA-770): the "Overdue" tab / KPI tile is the DERIVED overdue set (open status AND balance due AND
 * past due), not the strict status OVERDUE. The sweep never flips a PARTIAL invoice to OVERDUE, so a
 * strict `status=OVERDUE` query dropped past-due PARTIAL invoices the KPI tile counted.
 */
describe("invoiceListStatusParams", () => {
  it("OVERDUE sends isOverdue and never the strict status", () => {
    expect(invoiceListStatusParams("OVERDUE")).toEqual({ isOverdue: true });
    expect(invoiceListStatusParams("OVERDUE")).not.toHaveProperty("status");
  });

  it.each(["DRAFT", "SENT", "PARTIAL", "PAID", "VOID"])("%s stays a strict status", (status) => {
    expect(invoiceListStatusParams(status)).toEqual({ status });
  });

  it("an empty filter sends nothing", () => {
    expect(invoiceListStatusParams("")).toEqual({});
  });
});
