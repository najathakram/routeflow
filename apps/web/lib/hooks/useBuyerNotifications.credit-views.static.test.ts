import { readFileSync } from "fs";
import { join } from "path";
import { BUYER_CREDIT_VIEW_KEYS } from "./useBuyerNotifications";

/**
 * B546 (class): every buyer view that shows credit refreshes on a credit-note created or voided
 * event through ONE list. A new buyer query on a credit-bearing screen must join
 * BUYER_CREDIT_VIEW_KEYS or this fails.
 */
describe("B546: buyer credit views are one list", () => {
  const apiDir = join(__dirname, "..", "api");
  const CREDIT_BEARING =
    /^(statement|statement-months|payments|payment-preview|remittance|invoice|dashboard)$/;
  const used = new Set<string>();
  for (const file of ["buyer.ts", "buyer-payments.ts"]) {
    const src = readFileSync(join(apiDir, file), "utf8");
    for (const m of src.matchAll(/queryKey:\s*\["buyer",\s*"([a-z-]+)"/g)) used.add(m[1]);
  }

  it("finds the credit-bearing buyer queries it is meant to pin", () => {
    expect([...used].filter((k) => CREDIT_BEARING.test(k)).length).toBeGreaterThanOrEqual(5);
  });

  it("every credit-bearing buyer query key is refreshed by the credit-note events", () => {
    const listed = new Set<string>(BUYER_CREDIT_VIEW_KEYS.map((k) => k[1]));
    const missing = [...used].filter((k) => CREDIT_BEARING.test(k) && !listed.has(k));
    expect(missing).toEqual([]);
  });
});
