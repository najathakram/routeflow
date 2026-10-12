import { INVOICE_STATUS_VALUES } from "@routeflow/types";
import type { InvoiceStatus } from "./invoices";

/**
 * L-072: `InvoiceStatus` in lib/api/invoices.ts is the shared union from @routeflow/types, not a hand-typed
 * copy. The compile-time half (`check-types` compiles specs) fails if either side gains or loses a member;
 * the runtime half names the eight members so a deliberate change is visible in the diff.
 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const sameUnion: Equal<InvoiceStatus, (typeof INVOICE_STATUS_VALUES)[number]> = true;

describe("lib/api/invoices InvoiceStatus mirrors the shared enum (L-072)", () => {
  it("is exactly the INVOICE_STATUS_VALUES members", () => {
    expect(sameUnion).toBe(true);
    expect([...INVOICE_STATUS_VALUES].sort()).toEqual(
      ["DRAFT", "OVERDUE", "PAID", "PARTIAL", "SENT", "VIEWED", "VOID", "WRITTEN_OFF"].sort(),
    );
  });
});
