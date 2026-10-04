/**
 * Mobile fleet-OFF (owner ruling 2026-10-04, operator side only). When a tenant has neither the
 * recurring_routes nor the order_delivery module there is no fleet: the out-the-door order status reads
 * "Shipped" (a carrier / counter hand-off), never "Out for delivery". Labels and gates only — statuses and
 * transitions are untouched. Pure logic (mobile Jest is node-only), pinned here and in order-actions.test.ts.
 */
import {
  shipStatusLabel,
  fleetShippedLabel,
  isFleetOff,
  isShipMode,
  STATUS_FILTER_LABELS,
} from "../lib/fleet-labels";

const r = (enabled: boolean, resolved = true) => ({ enabled, resolved });

describe("isFleetOff — only a POSITIVELY resolved 'neither module' is fleet-off", () => {
  it("both modules resolved and off -> fleet off", () => {
    expect(isFleetOff(r(false), r(false))).toBe(true);
  });
  it.each([
    ["routes on", r(true), r(false)],
    ["delivery on", r(false), r(true)],
    ["both on", r(true), r(true)],
  ])("%s -> fleet stays on", (_n, routes, delivery) => {
    expect(isFleetOff(routes, delivery)).toBe(false);
  });
  it("fails OPEN while the addons read has not landed (loading / offline / 5xx): never hides on unknown", () => {
    expect(isFleetOff(r(false, false), r(false, false))).toBe(false);
    expect(isFleetOff(r(false, true), r(false, false))).toBe(false);
    expect(isFleetOff(r(false, false), r(false, true))).toBe(false);
  });
});

describe("shipStatusLabel — ship mode only", () => {
  it("OUT_FOR_DELIVERY -> Shipped when fleet is off; everything else keeps its own label", () => {
    expect(shipStatusLabel("OUT_FOR_DELIVERY", "Out for delivery", true)).toBe("Shipped");
    expect(shipStatusLabel("OUT_FOR_DELIVERY", "Out for delivery", false)).toBe("Out for delivery");
    for (const s of [
      "DRAFT",
      "PENDING",
      "CONFIRMED",
      "PARTIALLY_DELIVERED",
      "DELIVERED",
      "CANCELLED",
    ]) {
      expect(shipStatusLabel(s, `base-${s}`, true)).toBe(`base-${s}`);
    }
  });
  it("the helper text names the new label", () => {
    expect(fleetShippedLabel).toBe("Shipped");
  });
});

describe("STATUS_FILTER_LABELS — the orders-list chip", () => {
  it("the OUT_FOR_DELIVERY chip is 'Out' with a fleet and 'Shipped' without one", () => {
    expect(STATUS_FILTER_LABELS.OUT_FOR_DELIVERY(false)).toBe("Out");
    expect(STATUS_FILTER_LABELS.OUT_FOR_DELIVERY(true)).toBe("Shipped");
  });
});

describe("isShipMode — labels key on fulfilment_model === 'ship' ONLY, never on fleet-off", () => {
  it("only an explicit 'ship' counts", () => {
    expect(isShipMode({ fulfilment_model: "ship" })).toBe(true);
    for (const m of ["unset", "route", "mixed", ""]) {
      expect(isShipMode({ fulfilment_model: m })).toBe(false);
    }
  });
  it("unset / missing / loading modes -> today's labels (fleet-off or not)", () => {
    expect(isShipMode(undefined)).toBe(false);
    expect(isShipMode(null)).toBe(false);
    expect(isShipMode({})).toBe(false);
    expect(shipStatusLabel("OUT_FOR_DELIVERY", "Out for delivery", isShipMode({}))).toBe(
      "Out for delivery",
    );
    expect(STATUS_FILTER_LABELS.OUT_FOR_DELIVERY(isShipMode(undefined))).toBe("Out");
  });
});
