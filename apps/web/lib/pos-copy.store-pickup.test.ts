import { COUNTER_COPY } from "@routeflow/types";
import { POS_COPY } from "./pos-copy";
import { buildIndex } from "@/app/(dashboard)/settings/_components/settings-index";

/**
 * I-120 (SA-861 rule 10, owner naming ruling 2026-10-23): "POS mode" is renamed "Store pickup" in Create Order and the
 * settings search; "Counter sale" (the till) is unchanged. Copy only: the keys (`orders.posMode`, `USE_POS_MODE`,
 * `FulfillPath.PICKUP`) stay. One word per idea, from the shared constants web and mobile both read.
 */
describe("Store pickup copy (I-120)", () => {
  it("the shared names", () => {
    expect(COUNTER_COPY).toMatchObject({
      counterSale: "Counter sale",
      storePickup: "Store pickup",
      completeAtCounter: "Complete at counter",
    });
  });

  it("the Create Order switch reads Store pickup, and its failure names it", () => {
    expect(POS_COPY.switchLabel).toBe("Store pickup");
    expect(POS_COPY.switchFailed).toBe("Couldn't save your Store pickup setting. Try again.");
  });

  it("the settings search answers Store pickup and still finds it by 'pos'", () => {
    const entry = buildIndex({ isAdmin: true, fleet: true, counter: true }).find(
      (e) => e.id === "info-pos-mode",
    );
    expect(entry?.label).toBe("Store pickup");
    expect(entry?.answer).toContain("Store pickup");
    expect(entry?.answer).not.toContain("POS mode");
    expect(entry?.keywords).toEqual(expect.arrayContaining(["pos", "pos mode", "store pickup"]));
  });

  it("no user-facing string left says POS mode", () => {
    expect(Object.values(POS_COPY).join(" ")).not.toMatch(/POS mode/);
  });
});
