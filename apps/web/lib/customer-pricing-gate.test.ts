import { customerPricingGate } from "./customer-pricing-gate";

/**
 * SA-883 #3 / SA-884 rule 1: the gate reads a PLAN_GATE 403 on the customer-PRICES read (a plan without
 * flag.pricing_tiers) as a settled empty read, never as failed or waiting. It keys on the PLAN_GATE CODE, not a bare
 * 403: a role/permission 403, PLAN_GATE_UNAVAILABLE, a 5xx, a 404 or a network error still fails closed, and the
 * CUSTOMER read never gets the exception.
 */
const layerOff = { enabled: false, ready: true, failed: false, lineReady: () => true };
const err = (status?: number, data?: unknown) => ({
  response: status ? { status, data } : undefined,
});
const PLAN_GATE = { code: "PLAN_GATE", flag: "flag.pricing_tiers", state: "LOCKED_PAGE" };
const ok = { isError: false, data: { id: "c1" } };
const gate = (customerQuery: object, customerPricesQuery: object) =>
  customerPricingGate({ customerQuery, customerPricesQuery, priceLayer: layerOff });

describe("SA-883 #3 customerPricingGate", () => {
  it("a PLAN_GATE 403 on the prices read with no data: not failed, not pending, picking open", () => {
    expect(gate(ok, { isError: true, data: undefined, error: err(403, PLAN_GATE) })).toMatchObject({
      pending: false,
      failed: false,
      readFailed: false,
      blockPick: false,
      blockSave: false,
    });
  });

  it.each([
    ["a role/permission 403 (no code)", err(403, { message: "Forbidden" })],
    ["a 403 with another code", err(403, { code: "FORBIDDEN" })],
    [
      "a 403 PLAN_GATE_UNAVAILABLE (entitlements unreadable)",
      err(403, { code: "PLAN_GATE_UNAVAILABLE" }),
    ],
    ["a 503 PLAN_GATE_UNAVAILABLE", err(503, { code: "PLAN_GATE_UNAVAILABLE" })],
    ["a status-only 403 (no body)", { status: 403 }],
    ["a 500", err(500)],
    ["a 404", err(404)],
    ["a network error", err()],
    ["an error with no status shape", new Error("boom")],
  ])("prices: %s with no data still fails closed", (_l, e) => {
    expect(gate(ok, { isError: true, data: undefined, error: e })).toMatchObject({
      failed: true,
      readFailed: true,
      blockPick: true,
    });
  });

  it("a PLAN_GATE 403 on the CUSTOMER read still fails closed", () => {
    expect(
      gate(
        { isError: true, data: undefined, error: err(403, PLAN_GATE) },
        { isError: false, data: [] },
      ),
    ).toMatchObject({ failed: true, readFailed: true, blockPick: true });
  });
});
