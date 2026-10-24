/**
 * ONE home for "which invoice statuses are OPEN (issued and not settled)" (SA-770, row 308/318 review).
 *
 * The shared list `OPEN_INVOICE_STATUS_VALUES` lives in `packages/types/api/enums.ts` (a subset of
 * `INVOICE_STATUS_VALUES`) for web and mobile; the API keeps its own `OPEN_INVOICE_STATUSES`
 * (`invoice-status-sets.ts`) because it never value-imports `@routeflow/types` at runtime (L-261). This spec
 * is the pin that keeps the two set-equal, and checks the mobile jest stub copy and the one list the API's own
 * overdue filter composes.
 */
import * as path from "path";
import { InvoiceStatus } from "@prisma/client";
import { OPEN_INVOICE_STATUSES } from "./invoice-status-sets";
import { applyInvoiceStatusFilters } from "./invoice-list-query";

function readShared(): Record<string, unknown> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("@routeflow/types") as Record<string, unknown>;
  } catch {
    return {};
  }
}
const SHARED = readShared();
const asArray = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

describe("OPEN_INVOICE_STATUS_VALUES (shared) == OPEN_INVOICE_STATUSES (api)", () => {
  const shared = asArray(SHARED["OPEN_INVOICE_STATUS_VALUES"]);

  it("is exported by @routeflow/types and set-equal to the API's open set", () => {
    expect(shared.length).toBeGreaterThan(0);
    expect(new Set(shared)).toEqual(new Set(OPEN_INVOICE_STATUSES));
  });

  it("is a subset of INVOICE_STATUS_VALUES and of the Prisma InvoiceStatus enum", () => {
    const all = asArray(SHARED["INVOICE_STATUS_VALUES"]);
    expect(all.length).toBeGreaterThan(0);
    for (const s of shared) {
      expect(all).toContain(s);
      expect(Object.values(InvoiceStatus)).toContain(s);
    }
  });

  it("the mobile jest stub's copy is the same set (the stub cannot require the .ts source)", () => {
    const stubPath = path.resolve(
      __dirname,
      "../../../mobile/__tests__/__mocks__/@routeflow/types.js",
    );
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const stub = require(stubPath) as Record<string, unknown>;
    expect(asArray(stub["OPEN_INVOICE_STATUS_VALUES"]).length).toBeGreaterThan(0);
    expect(new Set(asArray(stub["OPEN_INVOICE_STATUS_VALUES"]))).toEqual(new Set(shared));
  });

  it("the API's isOverdue list filter composes exactly the open set", () => {
    const where: { status?: { in: string[] } } = {};
    applyInvoiceStatusFilters(where, { isOverdue: true } as never, null);
    expect(new Set(where.status?.in)).toEqual(new Set(OPEN_INVOICE_STATUSES));
  });
});
