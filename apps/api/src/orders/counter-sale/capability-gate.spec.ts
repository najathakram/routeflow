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

describe("default capability reader (until #3188 lands)", () => {
  it("returns the unset capability: ROUTE+SHIP, counter off, so the endpoint is dark today", async () => {
    const reader = new DefaultFulfilmentCapabilityReader();
    const cap = await reader.get("any-tenant");
    expect(cap.methods).toEqual(["ROUTE", "SHIP"]);
    expect(cap.counter).toBe("off");
    expect(counterSaleGate(cap)).toBe(false);
    expect(typeof FULFILMENT_CAPABILITY_READER).toBe("symbol");
  });
});
