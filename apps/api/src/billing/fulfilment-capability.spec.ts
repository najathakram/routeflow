import { deriveFulfilmentCapability } from "./fulfilment-capability";
import { FULFILMENT_MODE_VALUES, COUNTER_SALES_MODE_VALUES } from "@routeflow/types";

const derive = (mode: string, counterSales: string, fleet: boolean) =>
  deriveFulfilmentCapability({ mode, counterSales, fleet });

describe("deriveFulfilmentCapability — the one capability answer", () => {
  it("UNSET is today exactly: ROUTE or SHIP, ROUTE default, normal order, no counter, portal the same", () => {
    for (const fleet of [false, true]) {
      expect(derive("unset", "unset", fleet)).toEqual({
        methods: ["ROUTE", "SHIP"],
        staffDefault: "ROUTE",
        staffOpensAs: "order",
        portalMethods: ["ROUTE", "SHIP"],
        portalDefault: "ROUTE",
        counter: "off",
        fleet,
        consistent: true,
      });
    }
  });

  it("an unknown stored value is treated as unset", () => {
    expect(derive("martian", "whatever", true)).toEqual(derive("unset", "unset", true));
  });

  it.each([
    // mode, methods, staffDefault, opensAs
    ["delivery", ["ROUTE"], "ROUTE", "order"],
    ["ship", ["SHIP"], "SHIP", "order"],
    ["both", ["ROUTE", "SHIP"], "ROUTE", "order"],
    ["pickup", ["PICKUP"], "PICKUP", "counter"],
    ["pickup_ship", ["PICKUP", "SHIP"], "PICKUP", "counter"],
  ] as const)(
    "%s offers %j, default %s, staff opens as %s (portal mirrors)",
    (mode, methods, def, opens) => {
      const c = derive(mode, "unset", true);
      expect(c.methods).toEqual(methods);
      expect(c.staffDefault).toBe(def);
      expect(c.staffOpensAs).toBe(opens);
      expect(c.portalMethods).toEqual(methods);
      expect(c.portalDefault).toBe(def);
    },
  );

  it("the full table: 6 modes x counter_sales x fleet -> counter and consistent", () => {
    for (const mode of FULFILMENT_MODE_VALUES) {
      for (const counterSales of COUNTER_SALES_MODE_VALUES) {
        for (const fleet of [false, true]) {
          const c = derive(mode, counterSales, fleet);
          const inStore = mode === "pickup" || mode === "pickup_ship";
          expect(c.counter).toBe(inStore ? "always" : counterSales === "on" ? "optional" : "off");
          expect(c.consistent).toBe(!((mode === "delivery" || mode === "both") && !fleet));
          // fleet is the modules' answer, echoed untouched: no mode turns it on or off
          expect(c.fleet).toBe(fleet);
        }
      }
    }
  });

  it("pickup and pickup_ship with fleet OFF are consistent and allowed", () => {
    expect(derive("pickup", "unset", false).consistent).toBe(true);
    expect(derive("pickup_ship", "unset", false).consistent).toBe(true);
  });

  it("ship with the fleet ON stays ship and consistent (no refusal)", () => {
    const c = derive("ship", "unset", true);
    expect(c.methods).toEqual(["SHIP"]);
    expect(c.consistent).toBe(true);
    expect(c.fleet).toBe(true);
  });

  it("counter_sales on makes the counter optional for a non-in-store business and changes nothing else", () => {
    const off = derive("ship", "unset", false);
    const on = derive("ship", "on", false);
    expect(on.counter).toBe("optional");
    expect({ ...on, counter: "off" }).toEqual(off);
  });

  it("R3: SHIP appears only for the ship-family modes and unset (today), never as a 'fleet off' default", () => {
    for (const fleet of [false, true]) {
      expect(derive("delivery", "unset", fleet).methods).not.toContain("SHIP");
      expect(derive("pickup", "unset", fleet).methods).not.toContain("SHIP");
      expect(derive("unset", "unset", fleet).staffDefault).toBe("ROUTE");
    }
  });
});
