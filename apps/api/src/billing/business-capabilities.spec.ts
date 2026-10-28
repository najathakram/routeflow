import { BadRequestException } from "@nestjs/common";
import type { BusinessCapabilityTicks } from "@routeflow/types";
import {
  capabilitiesFromInputs,
  matchPreset,
  presetTicks,
  ticksToProfileDef,
} from "./business-capabilities";
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

  // SA-1028 K-R1 (supersedes the "unset ticks nothing" pin): an unset tenant is "not set up" but its card reads what
  // the business does TODAY: unset offers Delivery (when the fleet is held) and Shipping, and counter when counter_sales is on.
  it("K-R1: unset with a fleet held is not configured, and its ticks are what it does today", () => {
    const c = capabilitiesFromInputs(inputs("unset", "unset", true), ["driver_payments"]);
    expect(c).toMatchObject({
      configured: false,
      delivery: true,
      doorPayments: true,
      shipping: true,
      counter: false,
      opensAs: "order",
      opensAsChoosable: false,
      fleetHeld: true,
      matchedPreset: null,
    });
  });

  it("K-R1: unset without a fleet reads Shipping only (Delivery follows the fleet held)", () => {
    const c = capabilitiesFromInputs(inputs("unset", "unset", false), []);
    expect(c).toMatchObject({ configured: false, delivery: false, shipping: true, counter: false });
    expect(c.matchedPreset).toBeNull();
  });

  it("K-R1: unset with counter_sales on reads Counter ticked, and the opens-as stays an order", () => {
    const c = capabilitiesFromInputs(inputs("unset", "on", false), []);
    expect(c).toMatchObject({ configured: false, shipping: true, counter: true });
    expect(c.opensAs).toBe("order");
    expect(c.opensAsChoosable).toBe(true);
    expect(c.matchedPreset).toBeNull();
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

/**
 * BO-04: the ticks are a second INPUT to the one planner. `ticksToProfileDef` maps them to a `BusinessProfileDef`
 * (counter_sales is ALWAYS in `modes`, `on` or `unset`), and the same plan -> apply path runs on it.
 */
describe("ticksToProfileDef", () => {
  const ALL_FLEET = { recurring_routes: true, order_delivery: true, driver_payments: true };

  // [name, ticks, fulfilment_model, counter_sales, fleet, modules (undefined = same as fleet)]
  it.each([
    ["D", { delivery: true }, "delivery", "unset", true, undefined],
    ["S", { shipping: true }, "ship", "unset", false, undefined],
    ["C", { counter: true }, "pickup", "on", false, undefined],
    [
      "S+C (opens as counter by default)",
      { shipping: true, counter: true },
      "pickup_ship",
      "on",
      false,
      undefined,
    ],
    [
      "S+C opens as order",
      { shipping: true, counter: true, opensAs: "order" as const },
      "ship",
      "on",
      false,
      undefined,
    ],
    ["D+C", { delivery: true, counter: true }, "delivery", "on", true, undefined],
    ["D+S", { delivery: true, shipping: true }, "both", "unset", true, undefined],
    ["D+S+C", { delivery: true, shipping: true, counter: true }, "both", "on", true, undefined],
  ])("%s", (_name, ticks, model, counter, fleet, modules) => {
    const { def } = ticksToProfileDef(ticks);
    expect(def.modes).toEqual({ fulfilment_model: model, counter_sales: counter });
    expect(def.fleet).toBe(fleet);
    expect(def.modules).toEqual(modules);
  });

  it("door payments default to true with Delivery", () => {
    const { normalised } = ticksToProfileDef({ delivery: true });
    expect(normalised.doorPayments).toBe(true);
  });

  it("an omitted doorPayments takes the CURRENT value the caller read; an explicit value beats it", () => {
    expect(
      ticksToProfileDef({ delivery: true }, { doorPayments: false }).normalised.doorPayments,
    ).toBe(false);
    expect(
      ticksToProfileDef({ delivery: true }, { doorPayments: true }).normalised.doorPayments,
    ).toBe(true);
    expect(
      ticksToProfileDef({ delivery: true, doorPayments: true }, { doorPayments: false }).normalised
        .doorPayments,
    ).toBe(true);
    expect(
      ticksToProfileDef({ delivery: true, doorPayments: false }, { doorPayments: true }).normalised
        .doorPayments,
    ).toBe(false);
  });

  it("Delivery with doorPayments:false keeps the fleet and switches driver_payments off", () => {
    const { def, normalised, preset } = ticksToProfileDef({ delivery: true, doorPayments: false });
    expect(def.fleet).toBe(true);
    expect(def.modules).toEqual({ ...ALL_FLEET, driver_payments: false });
    expect(normalised.doorPayments).toBe(false);
    expect(preset).toBeNull();
    expect(def.key).toBe("custom");
  });

  it("doorPayments is ignored without Delivery", () => {
    for (const ticks of [
      { shipping: true, doorPayments: true },
      { counter: true, doorPayments: true },
    ]) {
      const { def, normalised } = ticksToProfileDef(ticks);
      expect(def.fleet).toBe(false);
      expect(def.modules).toBeUndefined();
      expect(normalised.doorPayments).toBe(false);
    }
  });

  it("opensAs is honoured only for Shipping + Counter without Delivery; otherwise it is normalised", () => {
    expect(ticksToProfileDef({ counter: true, opensAs: "order" }).normalised.opensAs).toBe(
      "counter",
    );
    expect(ticksToProfileDef({ shipping: true, opensAs: "counter" }).normalised.opensAs).toBe(
      "order",
    );
    expect(
      ticksToProfileDef({ delivery: true, counter: true, opensAs: "counter" }).normalised.opensAs,
    ).toBe("order");
    expect(
      ticksToProfileDef({ shipping: true, counter: true, opensAs: "order" }).normalised.opensAs,
    ).toBe("order");
    expect(ticksToProfileDef({ shipping: true, counter: true }).normalised.opensAs).toBe("counter");
  });

  it("the normalised ticks are presetTicks of the def (one derivation)", () => {
    const { def, normalised } = ticksToProfileDef({
      delivery: true,
      shipping: true,
      counter: true,
    });
    expect(normalised).toEqual(presetTicks(def));
  });

  it.each([
    [{}],
    [{ doorPayments: true }],
    [{ delivery: false, shipping: false, counter: false }],
    [{ opensAs: "order" as const }],
  ])("nothing ticked (%j) is a 400 BUSINESS_CAPABILITIES_EMPTY", (ticks) => {
    let thrown: unknown;
    try {
      ticksToProfileDef(ticks);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).getResponse()).toMatchObject({
      statusCode: 400,
      code: "BUSINESS_CAPABILITIES_EMPTY",
    });
  });

  it("alias parity: every preset's own ticks map back to that preset's fleet, modes and key", () => {
    for (const p of BUSINESS_PROFILES) {
      const { def, preset } = ticksToProfileDef(presetTicks(p));
      expect(def.fleet).toBe(p.fleet);
      expect(def.modes).toEqual(p.modes);
      expect(def.modules).toEqual(p.modules);
      expect(preset).toBe(p.key);
      expect(def.key).toBe(p.key);
    }
  });

  it("the two new presets exist and matchPreset finds them", () => {
    expect(BUSINESS_PROFILES.map((p) => p.key)).toEqual(
      expect.arrayContaining(["delivery_shipping", "delivery_shipping_pos"]),
    );
    expect(
      matchPreset({
        delivery: true,
        doorPayments: true,
        shipping: true,
        counter: false,
        opensAs: "order",
      }),
    ).toBe("delivery_shipping");
    expect(
      matchPreset({
        delivery: true,
        doorPayments: true,
        shipping: true,
        counter: true,
        opensAs: "order",
      }),
    ).toBe("delivery_shipping_pos");
  });

  it("Delivery with door payments off matches no preset", () => {
    expect(ticksToProfileDef({ delivery: true, doorPayments: false }).preset).toBeNull();
    expect(
      matchPreset({
        delivery: true,
        doorPayments: false,
        shipping: false,
        counter: false,
        opensAs: "order",
      }),
    ).toBeNull();
  });
});

/**
 * SA-1028 keep rule: a tenant that is "not set up" (fulfilment_model unset) works today as Delivery (fleet held) +
 * Shipping. When the admin leaves Delivery, Shipping and Opens-as as the card showed them and changes only something
 * else (Counter, door payments), the def carries NO fulfilment_model: the stored model stays unset, the carrier-in-
 * transit rule has no mode move to refuse, and invoicing stays at delivery. Changing D/S/Opens-as is a real change.
 */
describe("ticksToProfileDef keep rule (SA-1028)", () => {
  const unsetCurrent = (over: Partial<BusinessCapabilityTicks> = {}) => ({
    configured: false,
    doorPayments: true,
    ticks: {
      delivery: true,
      doorPayments: true,
      shipping: true,
      counter: false,
      opensAs: "order" as const,
      ...over,
    },
  });
  const sameDS = { delivery: true, doorPayments: true, shipping: true };

  it("K-R2 (unit): Delivery + Shipping unchanged, only Counter added: counter_sales alone, fulfilment_model omitted", () => {
    const { def, normalised, preset } = ticksToProfileDef(
      { ...sameDS, counter: true },
      unsetCurrent(),
    );
    expect(def.modes).toEqual({ counter_sales: "on" });
    expect(def.key).toBe("custom");
    expect(preset).toBeNull();
    expect(normalised).toEqual({
      delivery: true,
      doorPayments: true,
      shipping: true,
      counter: true,
      opensAs: "order",
    });
  });

  it("K-G2: unticking Shipping is a real change: fulfilment_model is carried", () => {
    const { def } = ticksToProfileDef(
      { delivery: true, shipping: false, counter: true },
      unsetCurrent(),
    );
    expect(def.modes).toEqual({ fulfilment_model: "delivery", counter_sales: "on" });
  });

  it("K-G1: unticking Delivery is a real change: fulfilment_model is carried (the guard then judges it)", () => {
    const { def } = ticksToProfileDef(
      { shipping: true, counter: true, opensAs: "order" },
      unsetCurrent(),
    );
    expect(def.modes).toEqual({ fulfilment_model: "ship", counter_sales: "on" });
    const pickupShip = ticksToProfileDef({ shipping: true, counter: true }, unsetCurrent());
    expect(pickupShip.def.modes.fulfilment_model).toBe("pickup_ship");
  });

  it("opens-as: the card's pre-filled 'order' is unchanged; an omitted one defaults to a counter sale (a real change)", () => {
    const cur = unsetCurrent({ delivery: false, doorPayments: false });
    const kept = ticksToProfileDef({ shipping: true, counter: true, opensAs: "order" }, cur);
    expect(kept.def.modes).toEqual({ counter_sales: "on" });
    const changed = ticksToProfileDef({ shipping: true, counter: true }, cur);
    expect(changed.def.modes).toEqual({ fulfilment_model: "pickup_ship", counter_sales: "on" });
  });

  it("K-G3: a configured ship tenant adding only Counter keeps its mode; the def reads Shipping", () => {
    const { def, normalised } = ticksToProfileDef(
      { shipping: true, counter: true, opensAs: "order" },
      {
        configured: true,
        doorPayments: false,
        ticks: {
          delivery: false,
          doorPayments: false,
          shipping: true,
          counter: false,
          opensAs: "order",
        },
      },
    );
    expect(def.modes).toEqual({ fulfilment_model: "ship", counter_sales: "on" });
    expect(normalised.shipping).toBe(true);
    expect(normalised.counter).toBe(true);
  });

  it("K-G6: an omitted doorPayments keeps the held value, on the kept path too", () => {
    const held = ticksToProfileDef(
      { delivery: true, shipping: true, counter: true },
      unsetCurrent(),
    );
    expect(held.normalised.doorPayments).toBe(true);
    expect(held.def.modules).toBeUndefined();
    const off = ticksToProfileDef(
      { delivery: true, shipping: true, counter: true },
      { ...unsetCurrent({ doorPayments: false }), doorPayments: false },
    );
    expect(off.normalised.doorPayments).toBe(false);
    expect(off.def.modes).toEqual({ counter_sales: "on" });
    expect(off.def.modules).toEqual({
      recurring_routes: true,
      order_delivery: true,
      driver_payments: false,
    });
  });

  it("with no current ticks (a preset's own ticks, the create form) nothing is kept: the model is always written", () => {
    const { def } = ticksToProfileDef({ ...sameDS, counter: true });
    expect(def.modes.fulfilment_model).toBe("both");
  });

  it("nothing ticked is still a 400 before the keep rule is consulted", () => {
    expect(() => ticksToProfileDef({}, unsetCurrent())).toThrow(BadRequestException);
  });
});

describe("PC-L contract C1/C2: the opens-as rule and capability availability come from the server", () => {
  it("C1: the API's opens-as rule equals the shared one over every combination", () => {
    const shared = jest.requireActual("@routeflow/types").isOpensAsChoosable;
    const local = jest.requireActual("./business-capabilities").isOpensAsChoosable;
    for (const delivery of [false, true])
      for (const shipping of [false, true])
        for (const counter of [false, true])
          expect(local({ delivery, shipping, counter })).toBe(
            shared({ delivery, shipping, counter }),
          );
  });

  it("C1: the shared opens-as rule is Shipping + Counter without Delivery", () => {
    const { isOpensAsChoosable } = jest.requireActual("@routeflow/types");
    expect(isOpensAsChoosable({ delivery: false, shipping: true, counter: true })).toBe(true);
    expect(isOpensAsChoosable({ delivery: true, shipping: true, counter: true })).toBe(false);
    expect(isOpensAsChoosable({ delivery: false, shipping: true, counter: false })).toBe(false);
    expect(isOpensAsChoosable({ delivery: false, shipping: false, counter: true })).toBe(false);
  });

  it("C2: every capability is available in today's registry (an empty map), keyed for delivery/shipping/counter only", () => {
    const { capabilityAvailability } = jest.requireActual("./business-capabilities");
    const a = capabilityAvailability();
    expect(a).toEqual({});
    for (const k of Object.keys(a)) expect(["delivery", "shipping", "counter"]).toContain(k);
  });

  it("C2: a mode the registry marks unavailable makes its capability unavailable, with a reason", () => {
    const { capabilityAvailability } = jest.requireActual("./business-capabilities");
    const off = (key: string, mode: string) => key === "fulfilment_model" && mode === "ship";
    expect(capabilityAvailability(off)).toEqual({ shipping: "Not available yet" });
  });
});
