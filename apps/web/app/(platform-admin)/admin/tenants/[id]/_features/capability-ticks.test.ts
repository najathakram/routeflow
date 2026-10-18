import type { BusinessCapabilities } from "@/lib/platform-admin/capabilities-contract";
import {
  NO_TICKS,
  nothingTicked,
  setDoorPayments,
  setOpensAs,
  tickedNames,
  ticksFromCapabilities,
  ticksKey,
  ticksToRequest,
  toggleCapability,
} from "./capability-ticks";

function caps(over: Partial<BusinessCapabilities> = {}): BusinessCapabilities {
  return {
    configured: true,
    delivery: false,
    doorPayments: false,
    shipping: false,
    counter: false,
    opensAs: "order",
    opensAsChoosable: false,
    counterCapability: "off",
    fleetHeld: false,
    matchedPreset: null,
    ...over,
  };
}

describe("ticksFromCapabilities", () => {
  it("a tenant that is not set up shows nothing ticked, whatever else the read says (D1)", () => {
    const ticks = ticksFromCapabilities(
      caps({ configured: false, delivery: true, counter: true, doorPayments: true }),
    );
    expect(ticks).toEqual(NO_TICKS);
    expect(nothingTicked(ticks)).toBe(true);
  });

  it("copies the server's ticks for a configured tenant", () => {
    expect(
      ticksFromCapabilities(
        caps({ delivery: true, doorPayments: true, counter: true, opensAs: "order" }),
      ),
    ).toEqual({
      delivery: true,
      doorPayments: true,
      shipping: false,
      counter: true,
      opensAs: "order",
    });
  });
});

describe("toggleCapability", () => {
  it("ticking Delivery turns door payments on; unticking it turns them off (re-ticking restores on)", () => {
    const on = toggleCapability(NO_TICKS, "delivery", true);
    expect(on.doorPayments).toBe(true);
    const off = toggleCapability(on, "delivery", false);
    expect(off.doorPayments).toBe(false);
    expect(toggleCapability(off, "delivery", true).doorPayments).toBe(true);
  });

  it("Shipping + Counter without Delivery defaults to opening as a counter sale (D6)", () => {
    const ship = toggleCapability(NO_TICKS, "shipping", true);
    const both = toggleCapability(ship, "counter", true);
    expect(both.opensAs).toBe("counter");
  });

  it("leaving that combination resets opens-as to order", () => {
    const both = toggleCapability(toggleCapability(NO_TICKS, "shipping", true), "counter", true);
    expect(toggleCapability(both, "delivery", true).opensAs).toBe("order");
  });

  it("keeps the admin's choice while the combination stays choosable", () => {
    const both = toggleCapability(toggleCapability(NO_TICKS, "shipping", true), "counter", true);
    expect(setOpensAs(both, "order").opensAs).toBe("order");
    expect(toggleCapability(setOpensAs(both, "order"), "shipping", true).opensAs).toBe("order");
  });
});

describe("ticksKey", () => {
  it("ignores values that cannot matter: door payments without Delivery, opens-as when not choosable", () => {
    const a = { ...NO_TICKS, counter: true, doorPayments: true, opensAs: "counter" as const };
    const b = { ...NO_TICKS, counter: true };
    expect(ticksKey(a)).toBe(ticksKey(b));
  });

  it("differs when a visible tick differs", () => {
    expect(ticksKey(setDoorPayments(toggleCapability(NO_TICKS, "delivery", true), false))).not.toBe(
      ticksKey(toggleCapability(NO_TICKS, "delivery", true)),
    );
  });
});

describe("ticksToRequest", () => {
  it("sends door payments only with Delivery, and opens-as only when the admin can choose it", () => {
    expect(ticksToRequest(toggleCapability(NO_TICKS, "counter", true))).toEqual({
      delivery: false,
      shipping: false,
      counter: true,
    });
    expect(ticksToRequest(toggleCapability(NO_TICKS, "delivery", true))).toEqual({
      delivery: true,
      doorPayments: true,
      shipping: false,
      counter: false,
    });
    const sc = toggleCapability(toggleCapability(NO_TICKS, "shipping", true), "counter", true);
    expect(ticksToRequest(sc)).toEqual({
      delivery: false,
      shipping: true,
      counter: true,
      opensAs: "counter",
    });
  });
});

describe("tickedNames", () => {
  it("lists the ticked boxes by their labels and nothing else", () => {
    const t = toggleCapability(toggleCapability(NO_TICKS, "delivery", true), "counter", true);
    expect(tickedNames(t)).toEqual([
      "Delivers on own trucks",
      "Collect payment at the door",
      "Sells at the counter",
    ]);
    expect(tickedNames(NO_TICKS)).toEqual([]);
  });
});
