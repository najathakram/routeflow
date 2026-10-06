import { BATCH_SHIP_MAX_ORDERS } from "@routeflow/types";
import { batchShipLimit, orderSelectControls, visibleSelectedIds } from "../lib/batch-ship-select";
import {
  BATCH_SHIP_COPY,
  BATCH_SHIP_TRACKING_SAVED_DETAIL,
  batchShipDetail,
} from "../lib/batch-ship-copy";

describe("orderSelectControls (#3168 MUST 1)", () => {
  it("ship-only tenant: Select shown, Plan trip hidden", () => {
    expect(orderSelectControls({ deliveryEnabled: false, offersShip: true })).toEqual({
      showSelect: true,
      showPlanTrip: false,
    });
  });
  it("delivery-only: Select + Plan trip, no ship actions", () => {
    expect(orderSelectControls({ deliveryEnabled: true, offersShip: false })).toEqual({
      showSelect: true,
      showPlanTrip: true,
    });
  });
  it("both: everything", () => {
    expect(orderSelectControls({ deliveryEnabled: true, offersShip: true })).toEqual({
      showSelect: true,
      showPlanTrip: true,
    });
  });
  it("neither: nothing", () => {
    expect(orderSelectControls({ deliveryEnabled: false, offersShip: false })).toEqual({
      showSelect: false,
      showPlanTrip: false,
    });
  });
});

describe("batchShipLimit (#3168 MUST 2)", () => {
  it("uses the shared cap", () => {
    expect(BATCH_SHIP_MAX_ORDERS).toBe(50);
  });
  it("at the cap is fine, one over is blocked with the exact copy", () => {
    expect(batchShipLimit(BATCH_SHIP_MAX_ORDERS)).toEqual({ tooMany: false, message: null });
    expect(batchShipLimit(BATCH_SHIP_MAX_ORDERS + 1)).toEqual({
      tooMany: true,
      message: "Select up to 50 orders to ship at once",
    });
  });
});

describe("visibleSelectedIds (#3168 g)", () => {
  it("drops selected ids that are not in the loaded list, keeping list order", () => {
    expect(visibleSelectedIds(new Set(["z", "b", "a"]), ["a", "b", "c"])).toEqual(["a", "b"]);
  });
});

describe("batchShipDetail (#3168 c)", () => {
  it("a not-shipped row whose tracking was saved says so, never 'nothing was changed'", () => {
    const d = batchShipDetail({ outcome: "FAILED", trackingSaved: true });
    expect(d).toMatch(/tracking was saved/i);
    expect(d).not.toMatch(/nothing was/i);
    const c = batchShipDetail({ outcome: "CREDIT_HOLD", trackingSaved: true });
    expect(c).toMatch(/tracking was saved/i);
  });
  it("has an explicit tracking-saved sentence for every outcome, none cut from another", () => {
    expect(Object.keys(BATCH_SHIP_TRACKING_SAVED_DETAIL).sort()).toEqual(
      Object.keys(BATCH_SHIP_COPY).sort(),
    );
    for (const d of Object.values(BATCH_SHIP_TRACKING_SAVED_DETAIL)) {
      expect(d).not.toMatch(/Nothing was/);
    }
  });
  it("otherwise the plain outcome copy", () => {
    expect(batchShipDetail({ outcome: "INVALID_TRACKING" })).toBe(
      BATCH_SHIP_COPY.INVALID_TRACKING.detail,
    );
    expect(batchShipDetail({ outcome: "SHIPPED", trackingSaved: true })).toBe("Marked shipped.");
  });
});
