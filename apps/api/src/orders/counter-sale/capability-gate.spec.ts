import { counterSaleGate, UNSET_CAPABILITY, type FulfilmentCapability } from "./capability-shape";
import {
  DefaultFulfilmentCapabilityReader,
  FULFILMENT_CAPABILITY_READER,
} from "./fulfilment-capability-reader";

/**
 * The ONE gate (SA-655): cap.counter is "always" | "optional" => on. The capability itself comes
 * from PR #3188's deriveFulfilmentCapability; until that lands the default reader returns the
 * "unset = today" capability, so production behaviour is unchanged (counter off).
 */
const withCounter = (counter: FulfilmentCapability["counter"]): FulfilmentCapability => ({
  ...UNSET_CAPABILITY,
  counter,
});

describe("counterSaleGate", () => {
  it.each([
    ["always", true],
    ["optional", true],
    ["off", false],
  ] as const)("counter %s => %s", (counter, expected) => {
    expect(counterSaleGate(withCounter(counter))).toBe(expected);
  });
});

describe("default capability reader (the real derivation)", () => {
  const make = (modes: Record<string, string>) =>
    new DefaultFulfilmentCapabilityReader(
      { getEffectiveMode: jest.fn(async (_t: string, k: string) => modes[k] ?? "unset") } as never,
      { getActiveAddons: jest.fn(async () => []) } as never,
      { allActive: jest.fn(async () => new Map()) } as never,
    );

  it("unset everything: ROUTE+SHIP, counter off, so the gate is closed (today)", async () => {
    const cap = await make({}).get("any-tenant");
    expect(cap.methods).toEqual(["ROUTE", "SHIP"]);
    expect(cap.counter).toBe("off");
    expect(counterSaleGate(cap)).toBe(false);
    expect(typeof FULFILMENT_CAPABILITY_READER).toBe("symbol");
  });

  it("counter_sales on => the gate opens as 'optional'", async () => {
    const cap = await make({ counter_sales: "on" }).get("t1");
    expect(cap.counter).toBe("optional");
    expect(counterSaleGate(cap)).toBe(true);
  });

  it("fulfilment_model pickup => 'always'", async () => {
    const cap = await make({ fulfilment_model: "pickup" }).get("t1");
    expect(cap.counter).toBe("always");
  });

  it("a null tenant => closed", async () => {
    expect(counterSaleGate(await make({ counter_sales: "on" }).get(null))).toBe(false);
  });

  it("a throwing mode read => closed", async () => {
    const r = new DefaultFulfilmentCapabilityReader(
      { getEffectiveMode: jest.fn().mockRejectedValue(new Error("db")) } as never,
      { getActiveAddons: jest.fn(async () => []) } as never,
      { allActive: jest.fn(async () => new Map()) } as never,
    );
    expect(counterSaleGate(await r.get("t1"))).toBe(false);
  });
});
