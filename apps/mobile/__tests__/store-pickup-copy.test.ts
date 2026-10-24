import { readFileSync } from "fs";
import { join } from "path";
import { COUNTER_COPY } from "@routeflow/types/counter-copy";
import { POS_COPY } from "../lib/pos-mode";

// I-120 (SA-861 rule 10, owner naming ruling 2026-10-23): "POS mode" is renamed "Store pickup" (copy only; the keys
// stay), the same shared words as web. "Counter sale" (the till) is unchanged.
describe("Store pickup copy (I-120, mobile mirrors web)", () => {
  it("the shared names", () => {
    expect(COUNTER_COPY).toMatchObject({
      counterSale: "Counter sale",
      storePickup: "Store pickup",
      completeAtCounter: "Complete at counter",
    });
  });

  it("the New order switch reads Store pickup, and its failure names it", () => {
    expect(POS_COPY.switchLabel).toBe("Store pickup");
    expect(POS_COPY.switchFailed).toBe("Couldn't save your Store pickup setting. Try again.");
    expect(Object.values(POS_COPY).join(" ")).not.toMatch(/POS mode/);
  });

  it("the cart's mode chip reads the shared name, never 'POS mode'", () => {
    const src = readFileSync(join(__dirname, "..", "components/new-order/CartModal.tsx"), "utf8");
    expect(src).not.toMatch(/"POS mode"/);
    expect(src).toMatch(/COUNTER_COPY\.storePickup/);
  });
});
