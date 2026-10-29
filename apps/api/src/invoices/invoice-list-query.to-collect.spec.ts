import { UserRole } from "@prisma/client";
import { applyInvoiceStatusFilters } from "./invoice-list-query";
import { TO_COLLECT_WHERE } from "./to-collect";

/**
 * SA-1026 Part A: the invoice list's "To collect" filter. A staff `toCollect=true` ANDs `TO_COLLECT_WHERE` onto the query, so
 * it intersects any status / customer filter instead of replacing it. A buyer's query never carries it: customers do not see
 * To collect, and the filter would tell them which of their invoices staff are waiting on. Rows carry the derived `toCollect`
 * state through the one row-flag helper both the list and the detail use.
 * The query field is set through a cast so the spec fails on the wrong value, not on a type error, until the DTO has it.
 */
const query = (extra: Record<string, unknown>) => extra as never;

describe("applyInvoiceStatusFilters toCollect (SA-1026)", () => {
  it("staff: ANDs TO_COLLECT_WHERE and leaves a status filter in place", () => {
    const where: any = {};
    applyInvoiceStatusFilters(
      where,
      query({ toCollect: true, statuses: ["PARTIAL"] }),
      null,
      UserRole.OPERATOR,
    );
    expect(where.AND).toEqual([TO_COLLECT_WHERE]);
    expect(where.status).toEqual({ in: ["PARTIAL"] });
  });

  it("staff without the flag: no clause at all", () => {
    const where: any = {};
    applyInvoiceStatusFilters(where, query({}), null, UserRole.OPERATOR);
    expect(where.AND).toBeUndefined();
  });

  it("a buyer's toCollect is ignored", () => {
    const where: any = {};
    applyInvoiceStatusFilters(where, query({ toCollect: true }), null, UserRole.CUSTOMER);
    expect(where.AND).toBeUndefined();
  });
});
