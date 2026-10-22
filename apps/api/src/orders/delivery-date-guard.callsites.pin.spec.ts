import * as fs from "fs";
import * as path from "path";

/**
 * Row 718 — WHO is held to the past-delivery-date rule. The guard is for USER-facing writes only:
 *   - OrdersService.create() (staff POST /orders, driver, buyer new order, POST /orders/sell, counter sale);
 *   - the buyer cart MERGE in BuyerController.createOrder (it writes the date onto the open order).
 * System writers keep writing whatever date they compute and must never import the guard:
 *   - order-templates.service.ts (standing-order generation stamps the run's own "today", cron or manual),
 *   - trips.service.ts (reads the date, never writes it),
 *   - orders/order-lifecycle.ts (applyBuyerMergeHeaderImpl: swallowed best-effort write AFTER the controller's check),
 *   - change-requests.service.ts (the rollover draft carries no requested date).
 * A new importer is a new decision: add it here on purpose, with the reason.
 */
const SRC = path.resolve(__dirname, "..");
const ALLOWED = ["buyer/buyer.controller.ts", "orders/orders.service.ts"];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.ts$/.test(e.name) && !/\.(spec|test)\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("delivery-date-guard call sites (row 718)", () => {
  const importers = walk(SRC)
    .filter((f) => !f.endsWith(path.join("orders", "delivery-date-guard.ts")))
    .filter((f) => /delivery-date-guard/.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(SRC, f).split(path.sep).join("/"))
    .sort();

  it("only the user-facing create/merge paths import the guard", () => {
    expect(importers).toEqual(ALLOWED);
  });

  it.each([
    "order-templates/order-templates.service.ts",
    "trips/trips.service.ts",
    "orders/order-lifecycle.ts",
    "orders/change-requests.service.ts",
  ])("system writer %s does not reference the guard", (rel) => {
    expect(fs.readFileSync(path.join(SRC, rel), "utf8")).not.toMatch(
      /delivery-date-guard|DELIVERY_DATE_IN_PAST/,
    );
  });
});
