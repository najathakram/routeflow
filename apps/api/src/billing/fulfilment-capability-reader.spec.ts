import { FEATURE_REGISTRY } from "./feature-registry";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import {
  capabilityFromInputs,
  readFulfilmentCapability,
  readFulfilmentInputs,
} from "./fulfilment-capability";

/**
 * The shared tenant-level read: the SAME calls `GET /tenants/me/features` makes (effective modes,
 * isFleetHeld, deriveFulfilmentCapability), with every failure collapsing to counter "off".
 */
/**
 * `pickup` and `pickup_ship` are `available: true` in the registry (the pickup mode API flipped them), so a
 * stored pickup reads as in-store. The UNAVAILABLE branch (SA-666a: a stored mode the registry marks
 * unavailable reads as unset) is dormant on real data, so `withUnavailable` flips the live registry row for
 * the duration of `fn` (restored in finally) to keep it covered.
 */
async function withUnavailable<T>(mode: string, fn: () => Promise<T>): Promise<T> {
  const row = FEATURE_REGISTRY.find((f) => f.key === "fulfilment_model")!.config!.modes[mode] as {
    available: boolean;
  };
  const before = row.available;
  row.available = false;
  try {
    return await fn();
  } finally {
    row.available = before;
  }
}

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

  it("(registry FIXTURE: pickup marked unavailable) a stored pickup reads as unset, so the counter is off", async () => {
    const cap = await withUnavailable("pickup", () =>
      readFulfilmentCapability(deps({ fulfilment_model: "pickup" }) as never, "t1"),
    );
    expect(cap).toMatchObject({
      counter: "off",
      methods: ["ROUTE", "SHIP"],
      staffOpensAs: "order",
    });
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

  it("the counter gate is strict: a failed fulfilment_model read with counter_sales 'on' is still off (never a half-read 'optional')", async () => {
    const d = deps({ counter_sales: "on" });
    d.featureConfig.getEffectiveMode.mockImplementation(async (_t: string, key: string) => {
      if (key === "fulfilment_model") throw new Error("db");
      return "on";
    });
    expect((await readFulfilmentCapability(d as never, "t1")).counter).toBe("off");
  });

  describe("readFulfilmentInputs (lets each caller keep its own failure semantics)", () => {
    it("a failed mode read reads as unset with modesFailed; the fleet read still answers", async () => {
      const d = deps({}, true);
      d.featureConfig.getEffectiveMode.mockRejectedValue(new Error("db"));
      const r = await readFulfilmentInputs(d as never, "t1");
      expect(r).toEqual({
        fulfilmentMode: "unset",
        counterSales: "unset",
        fleet: true,
        modesFailed: true,
      });
    });

    it("a failed fleet read is fleet:null (the caller decides: the tenants endpoint answers 503, the gate answers off)", async () => {
      const d = deps({ fulfilment_model: "pickup" });
      d.addonService.getActiveAddons.mockRejectedValue(new Error("db"));
      const r = await readFulfilmentInputs(d as never, "t1");
      expect(r).toMatchObject({ fulfilmentMode: "pickup", fleet: null, modesFailed: false });
      // the derivation itself never throws, and a null fleet reads as false (pickup is in-store: counter always)
      expect(capabilityFromInputs(r)).toMatchObject({ fleet: false, counter: "always" });
      const ship = await readFulfilmentInputs(
        (() => {
          const x = deps({ fulfilment_model: "ship" });
          x.addonService.getActiveAddons.mockRejectedValue(new Error("db"));
          return x;
        })() as never,
        "t1",
      );
      expect(capabilityFromInputs(ship)).toMatchObject({ methods: ["SHIP"], fleet: false });
    });
  });

  it("no copy of the capability calls anywhere else: getEffectiveMode('fulfilment_model') and deriveFulfilmentCapability( are read only in billing/fulfilment-capability.ts", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory()
          ? walk(p)
          : /\.ts$/.test(f) && !/\.spec\.ts$/.test(f)
            ? [p]
            : [];
      });
    const offenders = walk(join(__dirname, "..")).filter((p) => {
      if (p.endsWith(join("billing", "fulfilment-capability.ts"))) return false;
      // #3210's fulfil-path resolver derives THROUGH deriveFulfilmentCapability (the one derivation, with the
      // availability rule inside it); it reads getEffectiveMode only for the staff/buyer path choice.
      if (p.endsWith(join("orders", "fulfil-path-resolver.ts"))) return false;
      const src = readFileSync(p, "utf8");
      return (
        /getEffectiveMode\([^)]*["']fulfilment_model["']/.test(src) ||
        /deriveFulfilmentCapability\(/.test(src)
      );
    });
    expect(offenders).toEqual([]);
  });

  // SA-666b: every fulfilment_model mode and every counter_sales mode is available. Asserted against the REAL registry.
  describe("SA-666b: the real registry's availability decides what a stored mode reads as", () => {
    const modesOf = (key: string) =>
      FEATURE_REGISTRY.find((f) => f.key === key)!.config!.modes as Record<
        string,
        { available: boolean }
      >;

    it("every fulfilment_model and counter_sales mode is available", () => {
      for (const key of ["fulfilment_model", "counter_sales"])
        for (const m of Object.values(modesOf(key))) expect(m.available).toBe(true);
    });

    it.each([
      ["pickup", ["PICKUP"]],
      ["pickup_ship", ["PICKUP", "SHIP"]],
    ])(
      "%s stored => in-store: its methods, counter always, even with counter_sales unset",
      async (stored, methods) => {
        const cap = await readFulfilmentCapability(
          deps({ fulfilment_model: stored }) as never,
          "t1",
        );
        expect(cap).toMatchObject({ counter: "always", methods });
      },
    );

    it("pickup stored + counter_sales on => the counter is still 'always'", async () => {
      const cap = await readFulfilmentCapability(
        deps({ fulfilment_model: "pickup", counter_sales: "on" }) as never,
        "t1",
      );
      expect(cap.counter).toBe("always");
    });

    it("an available stored mode (ship) is honoured", async () => {
      const cap = await readFulfilmentCapability(deps({ fulfilment_model: "ship" }) as never, "t1");
      expect(cap.methods).toEqual(["SHIP"]);
    });
  });
});
