import { customerPricingGate, isPlanGateError, pricesUnconfirmed } from "./customer-pricing-gate";

/**
 * W-725 (SA-868 / SA-870 / SA-873): the ONE customer-pricing gate, pure and shared by web and mobile. Money fails CLOSED:
 * a staff form may suggest a customer's price only once the customer, their customer-product prices and (flag on) the
 * price layer are read. Truth table:
 *  - waiting  = a read with no data and no error that is pending (TanStack v5 `isPending`; a read PAUSED offline is
 *               pending but not loading) or loading;
 *  - readFailed = a customer / customer-price read that errored AND holds no data (stale data still prices correctly);
 *  - failed   = readFailed, or the layer failed (any error);
 *  - blockPick = pending || failed;
 *  - blockSave = pending || an unconfirmed layer price || (failed && openSuggestions).
 */
const off = { enabled: false, ready: true, failed: false, lineReady: () => true };
const read = (over: Record<string, unknown> = {}) => ({ data: {}, ...over });
const gate = (over: Partial<Parameters<typeof customerPricingGate>[0]> = {}) =>
  customerPricingGate({
    customerQuery: read(),
    customerPricesQuery: read(),
    priceLayer: off,
    ...over,
  });

describe("customerPricingGate (W-725 truth table)", () => {
  it("everything read: nothing blocks", () => {
    expect(gate()).toEqual({
      pending: false,
      failed: false,
      readFailed: false,
      blockPick: false,
      blockSave: false,
    });
  });

  it("a read still loading blocks the pick and Save", () => {
    const g = gate({ customerQuery: { isLoading: true } });
    expect(g).toMatchObject({ pending: true, blockPick: true, blockSave: true });
  });

  it("a read PAUSED offline (pending, not loading, no data, no error) blocks like a loading one", () => {
    const g = gate({ customerPricesQuery: { isPending: true, isLoading: false } });
    expect(g).toMatchObject({ pending: true, blockPick: true, blockSave: true });
  });

  it("a read that failed with NO data fails closed: no pick; Save only while a suggestion is open", () => {
    const failedRead = { isError: true, data: undefined };
    expect(gate({ customerQuery: failedRead })).toMatchObject({
      failed: true,
      readFailed: true,
      blockPick: true,
      blockSave: false,
    });
    expect(gate({ customerPricesQuery: failedRead, openSuggestions: true })).toMatchObject({
      blockPick: true,
      blockSave: true,
    });
  });

  it("an error WITH data present (a stale refetch) does not block", () => {
    expect(gate({ customerQuery: read({ isError: true }) })).toMatchObject({
      failed: false,
      blockPick: false,
      blockSave: false,
    });
  });

  it("a failed layer (any error) blocks the pick and, via pricesUnconfirmed, Save", () => {
    const layer = { enabled: true, ready: false, failed: true, lineReady: () => false };
    expect(gate({ priceLayer: layer, productIds: ["p1"] })).toMatchObject({
      pending: false,
      failed: true,
      blockPick: true,
      blockSave: true,
    });
  });

  it("a layer still being read is pending", () => {
    const layer = { enabled: true, ready: false, failed: false, lineReady: () => false };
    expect(gate({ priceLayer: layer })).toMatchObject({
      pending: true,
      blockPick: true,
      blockSave: true,
    });
  });
});

const http = (status: number, code?: string) => ({
  isError: true,
  data: undefined,
  error: { response: { status, data: code ? { code } : {} } },
});
const planGate = http(403, "PLAN_GATE");

/**
 * SA-883/884 (#3658 MUST): GET /customers/:id/prices is @RequirePlanFlag("flag.pricing_tiers"), enforced in prod since 09-17. A
 * tenant whose plan lacks the flag (every LITE plan) gets the PLAN_GATE 403 there: an EMPTY customer-price read (no
 * overrides), not a failure, so the pick prices at the customer's own tier. Only that read and only that code: a role 403,
 * PLAN_GATE_UNAVAILABLE, 5xx, 404, a network error and any 403 on the customer read still fail closed.
 */
describe("customerPricingGate: a PLAN_GATE 403 on the customer-price read is an empty read (SA-883/884)", () => {
  it("prices PLAN_GATE 403 with no data: nothing blocks (an un-flagged tenant can pick)", () => {
    expect(gate({ customerPricesQuery: planGate })).toEqual({
      pending: false,
      failed: false,
      readFailed: false,
      blockPick: false,
      blockSave: false,
    });
  });

  it("a role 403 (no PLAN_GATE code) and PLAN_GATE_UNAVAILABLE still fail closed", () => {
    for (const q of [http(403), http(403, "FORBIDDEN"), http(403, "PLAN_GATE_UNAVAILABLE")])
      expect(gate({ customerPricesQuery: q })).toMatchObject({ failed: true, blockPick: true });
  });

  it("prices 500, 404 or a network error (no response) still fail closed", () => {
    for (const q of [http(500), http(404), { isError: true, error: new Error("Network Error") }])
      expect(gate({ customerPricesQuery: q })).toMatchObject({
        failed: true,
        readFailed: true,
        blockPick: true,
      });
  });

  it("a PLAN_GATE 403 on the CUSTOMER read still fails closed", () => {
    expect(gate({ customerQuery: planGate })).toMatchObject({ failed: true, blockPick: true });
  });
});

describe("isPlanGateError", () => {
  it("is true only for a 403 whose body code is exactly PLAN_GATE", () => {
    expect(isPlanGateError(planGate.error)).toBe(true);
    expect(isPlanGateError(http(403, "PLAN_GATE_UNAVAILABLE").error)).toBe(false);
    expect(isPlanGateError(http(402, "PLAN_GATE").error)).toBe(false);
    expect(isPlanGateError(undefined)).toBe(false);
    expect(isPlanGateError(new Error("x"))).toBe(false);
  });
});

describe("pricesUnconfirmed (moved, pure)", () => {
  it("flag off never blocks; pending or failed blocks; an incomplete layer blocks only absent products", () => {
    expect(
      pricesUnconfirmed({ enabled: false, ready: false, lineReady: () => false }, ["p1"]),
    ).toBe(false);
    expect(pricesUnconfirmed({ enabled: true, ready: false, lineReady: () => true }, [])).toBe(
      true,
    );
    const partial = { enabled: true, ready: true, lineReady: (id?: string | null) => id === "p1" };
    expect(pricesUnconfirmed(partial, ["p1"])).toBe(false);
    expect(pricesUnconfirmed(partial, ["p1", "p2"])).toBe(true);
    expect(pricesUnconfirmed(partial, [null, undefined])).toBe(false);
  });
});
