import { BadRequestException } from "@nestjs/common";
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
