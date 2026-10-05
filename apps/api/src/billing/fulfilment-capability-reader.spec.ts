import { FEATURE_REGISTRY } from "./feature-registry";
import { readFulfilmentCapability } from "./fulfilment-capability";

/**
 * The shared tenant-level read: the SAME calls `GET /tenants/me/features` makes (effective modes,
 * isFleetHeld, deriveFulfilmentCapability), with every failure collapsing to counter "off".
 */
describe("readFulfilmentCapability", () => {
  const deps = (modes: Record<string, string> = {}, fleet = false) => ({
    featureConfig: {
      getEffectiveMode: jest.fn(async (_t: string, key: string) => modes[key] ?? "unset"),
    },
    addonService: { getActiveAddons: jest.fn(async () => (fleet ? ["order_delivery"] : [])) },
    featureOverrides: { allActive: jest.fn(async () => new Map()) },
  });

  it("counter_sales unset and fulfilment unset => counter off (today)", async () => {
    const cap = await readFulfilmentCapability(deps() as never, "t1");
    expect(cap.counter).toBe("off");
    expect(cap.methods).toEqual(["ROUTE", "SHIP"]);
  });

  it("counter_sales on => counter optional", async () => {
    const cap = await readFulfilmentCapability(deps({ counter_sales: "on" }) as never, "t1");
    expect(cap.counter).toBe("optional");
  });

  it("fulfilment_model pickup => counter always, PICKUP only", async () => {
    const cap = await readFulfilmentCapability(deps({ fulfilment_model: "pickup" }) as never, "t1");
    expect(cap).toMatchObject({ counter: "always", methods: ["PICKUP"], staffOpensAs: "counter" });
  });

  it("reads the modes for THIS tenant and the fleet from the add-on/override services", async () => {
    const d = deps({ fulfilment_model: "delivery" }, true);
    const cap = await readFulfilmentCapability(d as never, "t9");
    expect(d.featureConfig.getEffectiveMode).toHaveBeenCalledWith("t9", "fulfilment_model");
    expect(d.featureConfig.getEffectiveMode).toHaveBeenCalledWith("t9", "counter_sales");
    expect(d.addonService.getActiveAddons).toHaveBeenCalledWith("t9");
    expect(cap).toMatchObject({ fleet: true, consistent: true });
  });

  it("a null tenant => counter off, nothing read", async () => {
    const d = deps({ fulfilment_model: "pickup" });
    const cap = await readFulfilmentCapability(d as never, null);
    expect(cap.counter).toBe("off");
    expect(d.featureConfig.getEffectiveMode).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a mode read",
      (d: any) => d.featureConfig.getEffectiveMode.mockRejectedValue(new Error("db")),
    ],
    [
      "the fleet read",
      (d: any) => d.addonService.getActiveAddons.mockRejectedValue(new Error("db")),
    ],
    [
      "the override read",
      (d: any) => d.featureOverrides.allActive.mockRejectedValue(new Error("db")),
    ],
  ])("%s throwing => counter off, never a throw and never a guessed 'on'", async (_n, breakIt) => {
    const d = deps({ fulfilment_model: "pickup", counter_sales: "on" });
    breakIt(d);
    const cap = await readFulfilmentCapability(d as never, "t1");
    expect(cap.counter).toBe("off");
  });

  // SA-666a. On master EVERY fulfilment_model / counter_sales mode is `available: true`, so the
  // unavailable branch cannot trigger from real registry data; this spec flips one mode's flag on
  // the live registry row (restored in finally) to prove the branch itself. Without that flip the
  // spec would be vacuous on master.
  describe("SA-666a: a stored mode the registry marks unavailable reads as unset", () => {
    const mode = () =>
      FEATURE_REGISTRY.find((f) => f.key === "fulfilment_model")!.config!.modes["pickup"] as {
        available: boolean;
      };

    it("master: every fulfilment_model and counter_sales mode is available (so the check is dormant)", () => {
      for (const key of ["fulfilment_model", "counter_sales"]) {
        const modes = FEATURE_REGISTRY.find((f) => f.key === key)!.config!.modes;
        for (const m of Object.values(modes)) expect(m.available).toBe(true);
      }
    });

    it("pickup stored while unavailable => unset (counter off), not 'always'", async () => {
      const row = mode();
      row.available = false;
      try {
        const cap = await readFulfilmentCapability(
          deps({ fulfilment_model: "pickup" }) as never,
          "t1",
        );
        expect(cap).toMatchObject({ counter: "off", methods: ["ROUTE", "SHIP"] });
      } finally {
        row.available = true;
      }
    });

    it("pickup stored while available => always (the flip above did not leak)", async () => {
      const cap = await readFulfilmentCapability(
        deps({ fulfilment_model: "pickup" }) as never,
        "t1",
      );
      expect(cap.counter).toBe("always");
    });
  });
});
