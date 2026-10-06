import { INVOICE_STATUS_VALUES, type InvoiceStatus } from "@routeflow/types";
import type { BadgeVariant } from "@routeflow/ui/web";
import { invoiceStatusVariant } from "./buyer-invoice-status";

/**
 * B1122 fold (L-072): the buyer invoices list used to hand-type its statuses
 * (PARTIALLY_PAID / PENDING / CANCELLED — none of them real), so a part-paid invoice got the
 * neutral pill. The tone now comes from the shared InvoiceStatus enum through an exhaustive
 * switch. This table is typed `Record<InvoiceStatus, …>`, so a new enum value fails type-check
 * HERE until someone decides its tone; the loop below fails at run time if the table or the
 * mapper misses a value.
 */
const EXPECTED: Record<InvoiceStatus, BadgeVariant> = {
  DRAFT: "neutral",
  SENT: "neutral",
  VIEWED: "info",
  PARTIAL: "warning",
  PAID: "success",
  OVERDUE: "danger",
  VOID: "neutral",
  WRITTEN_OFF: "neutral",
};

describe("invoiceStatusVariant", () => {
  it("lists every InvoiceStatus value in the expected table (and nothing else)", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...INVOICE_STATUS_VALUES].sort());
  });

  it.each(INVOICE_STATUS_VALUES)("%s maps to its deliberate tone", (status) => {
    expect(EXPECTED[status]).toBeDefined();
    expect(invoiceStatusVariant(status)).toBe(EXPECTED[status]);
  });

  it("falls back to neutral for a status this build does not know yet", () => {
    expect(invoiceStatusVariant("SOMETHING_NEW" as InvoiceStatus)).toBe("neutral");
  });

  it("never returns a tone for the hand-typed names that are not real statuses", () => {
    for (const fake of ["PARTIALLY_PAID", "PENDING", "CANCELLED"]) {
      expect(INVOICE_STATUS_VALUES).not.toContain(fake);
    }
  });
});
