import { readFileSync } from "fs";
import { join } from "path";

/**
 * L-214 sweep for SA-714 R1 / SA-716: EVERY caller of the stock helpers, and what it does to
 * `OrderItem.backorderedPieces`. A new caller fails this spec until it is classified here AND in the
 * PR's caller table (path:line, sets / adjusts / none, why, pin).
 *
 *  SETS (a fresh sale moment: the marker is that decrement's own per-line result)
 *   - orders.service.ts create()                  non-draft create: staff create, buyer createOrder, the
 *                                                 counter sale (createSale -> create), the rollover
 *                                                 (approveNextDelivery -> create) all reach it
 *   - orders.service.ts changeStatus promotion    DRAFT -> PENDING (rows exist: written by id)
 *   - order-stock.ts restoreStockForReopen        reopen from CANCELLED (markerMode "set")
 *   - order-templates.service.ts                  the template cron / manual run / buyer reorder
 *  ADJUSTS (an edit: an increase adds its delta, a reduction releases first)
 *   - orders.service.ts updateOrderItems          diff edits (web, mobile, the staff create-merge fold is
 *                                                 a replace-all: "recreated", see NONE)
 *   - orders.service.ts at-door CR approval       approveChangeRequestAtStop
 *  NONE (writes nothing; the marker is a fact of the sale)
 *   - orders.service.ts demote (PENDING -> DRAFT) and cancel (final = no lines)
 *   - recreate-mode edits (B1167): new line ids, the marker is lost, documented
 *   - pickup-complete / batch-ship: changeStatus to DELIVERED / SHIPPED, no stock helper at all
 *  CARRIES: the merge fold (buildMergeLineWrites) - pinned in backorder-marker-merge.spec.ts.
 */
const SRC = join(__dirname, "..");
const read = (f: string) => readFileSync(join(SRC, f), "utf8");
const calls = (f: string) =>
  [
    ...read(f).matchAll(
      /await (?:this\.)?(decrementStockForSale|settleStockForEdit|restoreStockForReopen)\(/g,
    ),
  ].map((m) => m[1]);

describe("every caller of the stock helpers is classified for the backorder marker", () => {
  it("orders.service.ts: create + promotion SET; demote + reopen-wrapper + edit + at-door", () => {
    expect(calls("orders/orders.service.ts")).toEqual([
      "decrementStockForSale", // create()                         SETS
      "decrementStockForSale", // changeStatus DRAFT -> PENDING    SETS
      "settleStockForEdit", //    demote                           NONE (final = [])
      "restoreStockForReopen", // reopenOrder                      SETS (markerMode "set")
      "settleStockForEdit", //    updateOrderItems                 ADJUSTS (NONE when recreated)
      "settleStockForEdit", //    at-door CR approval              ADJUSTS
      "settleStockForEdit", //    deleteOrder (B284)               NONE (final = [], the cancel's unwind)
    ]);
  });
  it("the template cron is the only other decrement caller (SETS)", () => {
    expect(calls("order-templates/order-templates.service.ts")).toEqual(["decrementStockForSale"]);
  });
  it("order-stock.ts: the reopen re-decrement is a SET, never an adjust", () => {
    const src = read("orders/order-stock.ts");
    expect(calls("orders/order-stock.ts")).toEqual(["settleStockForEdit"]);
    expect(src.match(/markerMode: "set"/g)).toHaveLength(1);
  });
  it("pickup-complete and batch-ship call no stock helper at all (NONE)", () => {
    for (const f of [
      "orders/counter-sale/pickup-complete.service.ts",
      "orders/order-batch-ship.ts",
    ]) {
      expect(calls(f)).toEqual([]);
    }
  });
  it("cancel and demote pass an empty final line set (so they can never write a marker)", () => {
    const src = read("orders/orders.service.ts");
    expect(src).toMatch(
      /settleStockForEdit\(tx, demoted, activeItems, \[\], user, \{ notes: "DEMOTE" \}\)/,
    );
    // SA-762r F1: the cancel's credit moved verbatim to cancelOrderInTx (order-cancel-tx.ts), bound dep-style.
    expect(read("orders/order-cancel-tx.ts")).toMatch(
      /deps\.settleStockForEdit\(tx, lockedOrder, activeItems, \[\], user,/,
    );
  });
});
