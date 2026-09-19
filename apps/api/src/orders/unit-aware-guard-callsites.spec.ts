import { readFileSync } from "fs";
import { join } from "path";

/**
 * Meta-spec (units_v1 step 4): every listed order/invoice REWRITE path must keep calling the
 * unit-aware guard (or the merge-candidate filter) until it is converted to `resolveLineUnits`.
 * Converting a path = delete its row here in the SAME PR that makes it unit-aware. A path missing
 * from this table is an unguarded rewrite path — add it (or prove it copies snapshots verbatim).
 * The listing comes from the 2026-09-19 write-path audit; SAFE-COPY paths need no guard.
 */
const GUARDED: Array<{ file: string; method: string; token: string }> = [
  {
    file: "orders/orders.service.ts",
    method: "updateOrderItems",
    token: "unitAware.assertOrderEditAllowed(",
  },
  {
    file: "orders/orders.service.ts",
    method: "approveChangeRequestAtStop",
    token: "unitAware.assertChangeTargetAllowed(",
  },
  {
    file: "orders/orders.service.ts",
    method: "forceConsolidateCustomer",
    token: "unitAware.assertNoUnitAwareLines(",
  },
  {
    file: "orders/orders.service.ts",
    method: "mergeAllPendingForCustomer",
    token: "unitAware.isUnitAwareLine",
  },
  {
    file: "orders/orders.service.ts",
    method: "findActiveOrder",
    token: "unitAware.ORDER_HAS_NO_UNIT_AWARE_LINE",
  },
  {
    file: "orders/change-requests.service.ts",
    method: "approveNextDelivery",
    token: "unitAware.assertNoUnitAwareLines(",
  },
  {
    file: "invoices/invoices.service.ts",
    method: "update",
    token: "unitAware.assertInvoiceRewriteAllowed(",
  },
  {
    file: "invoices/invoices.service.ts",
    method: "duplicate",
    token: "unitAware.assertNoUnitAwareLines(",
  },
  {
    file: "invoices/invoices.service.ts",
    method: "applyPriceAdjustment",
    token: "unitAware.assertNoUnitAwareLines(",
  },
];

/** Source of `method` = from its 2-space-indented declaration to the next one, comments stripped
 *  (a guard call that only exists in a comment must not satisfy the ratchet). */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
function methodBody(rawSrc: string, method: string): string {
  const src = stripComments(rawSrc);
  const decl = new RegExp(`^  (?:private |public )?(?:async )?${method}\\(`, "m");
  const start = src.search(decl);
  if (start < 0) return "";
  const rest = src.slice(start + 1);
  const next = rest.search(/^  (?:private |public )?(?:async )?[A-Za-z_]+\(/m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("unit-aware guard call-site ratchet", () => {
  it.each(GUARDED.map((g) => [g.file, g.method, g.token]))(
    "%s :: %s still calls %s",
    (file, method, token) => {
      const body = methodBody(readFileSync(join(__dirname, "..", file), "utf8"), method);
      expect(body.length).toBeGreaterThan(200); // a real method body, not a stub match
      expect(body).toContain(token);
    },
  );

  it("the body extractor really isolates one method (a regex returning the whole file would pass vacuously)", () => {
    const src = readFileSync(join(__dirname, "..", "orders/orders.service.ts"), "utf8");
    const a = methodBody(src, "findActiveOrder");
    expect(a.length).toBeLessThan(4500);
    expect(a).not.toContain("async updateOrderItems(");
  });
});
