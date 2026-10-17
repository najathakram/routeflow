import { capabilitiesFromInputs, matchPreset, presetTicks } from "./business-capabilities";
import { BUSINESS_PROFILES } from "./business-profiles";
import type { FulfilmentInputs } from "./fulfilment-capability";

const inputs = (
  fulfilmentMode: string,
  counterSales: string,
  fleet: boolean | null,
): FulfilmentInputs => ({ fulfilmentMode, counterSales, fleet, modesFailed: false });

describe("capabilitiesFromInputs", () => {
  it("delivery + counter on + fleet + driver payments matches delivery_pos", () => {
    const c = capabilitiesFromInputs(inputs("delivery", "on", true), ["driver_payments"]);
    expect(c).toMatchObject({
      configured: true,
      delivery: true,
      shipping: false,
      counter: true,
      doorPayments: true,
      opensAs: "order",
      opensAsChoosable: false,
      fleetHeld: true,
      matchedPreset: "delivery_pos",
    });
  });

  it("ship + counter on is not shipping_wholesaler, and opens as a choosable order", () => {
    const c = capabilitiesFromInputs(inputs("ship", "on", false), []);
    expect(c.matchedPreset).toBeNull();
    expect(c).toMatchObject({ shipping: true, counter: true, delivery: false });
    expect(c.opensAsChoosable).toBe(true);
  });

  it("ship alone is shipping_wholesaler", () => {
    expect(capabilitiesFromInputs(inputs("ship", "unset", false), []).matchedPreset).toBe(
      "shipping_wholesaler",
    );
  });

  it("unset with a fleet held is not configured and ticks nothing", () => {
    const c = capabilitiesFromInputs(inputs("unset", "unset", true), ["driver_payments"]);
    expect(c).toMatchObject({
      configured: false,
      delivery: false,
      doorPayments: false,
      shipping: false,
      counter: false,
      matchedPreset: null,
    });
  });

  it("Delivery without the fleet held matches no preset (a lapsed fleet add-on is not delivery_pos)", () => {
    const c = capabilitiesFromInputs(inputs("delivery", "on", false), ["driver_payments"]);
    expect(c.fleetHeld).toBe(false);
    expect(c.matchedPreset).toBeNull();
  });

  it("a null fleet read counts as no fleet", () => {
    expect(capabilitiesFromInputs(inputs("ship", "unset", null), []).fleetHeld).toBe(false);
  });
});

describe("matchPreset / presetTicks parity", () => {
  it.each(BUSINESS_PROFILES.map((d) => [d.key, d] as const))(
    "%s: its own modes and fleet read back as its own ticks",
    (key, def) => {
      const held = def.fleet ? ["driver_payments"] : [];
      const c = capabilitiesFromInputs(
        inputs(def.modes.fulfilment_model, def.modes.counter_sales ?? "unset", def.fleet),
        held,
      );
      const { delivery, doorPayments, shipping, counter, opensAs } = c;
      expect({ delivery, doorPayments, shipping, counter, opensAs }).toEqual(presetTicks(def));
      expect(c.matchedPreset).toBe(key);
      expect(matchPreset(presetTicks(def))).toBe(key);
    },
  );

  it("returns null when no preset has that tuple", () => {
    expect(
      matchPreset({
        delivery: true,
        doorPayments: false,
        shipping: true,
        counter: false,
        opensAs: "order",
      }),
    ).toBeNull();
  });
});
