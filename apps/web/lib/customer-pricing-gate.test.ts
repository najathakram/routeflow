import { customerPricingGate } from "./customer-pricing-gate";

/**
 * SA-883 #3: the gate reads a plan-gated (HTTP 403) customer-PRICES read as a settled empty read, never as failed or
 * waiting. Every other failure fails closed, and the CUSTOMER read never gets the 403 exception.
 */
const layerOff = { enabled: false, ready: true, failed: false, lineReady: () => true };
const err = (status?: number) => ({ response: status ? { status } : undefined });
const ok = { isError: false, data: { id: "c1" } };
const gate = (customerQuery: object, customerPricesQuery: object) =>
  customerPricingGate({ customerQuery, customerPricesQuery, priceLayer: layerOff });

describe("SA-883 #3 customerPricingGate", () => {
  it("prices 403 with no data: not failed, not pending, picking open", () => {
    expect(gate(ok, { isError: true, data: undefined, error: err(403) })).toMatchObject({
      pending: false,
      failed: false,
      readFailed: false,
      blockPick: false,
      blockSave: false,
    });
  });

  it.each([
    ["500", err(500)],
    ["404", err(404)],
    ["a network error", err()],
    ["an error with no status shape", new Error("boom")],
  ])("prices %s with no data still fails closed", (_l, e) => {
    expect(gate(ok, { isError: true, data: undefined, error: e })).toMatchObject({
      failed: true,
      readFailed: true,
      blockPick: true,
    });
  });

  it("a status read from `status` (fetch-style) is honoured too", () => {
    expect(gate(ok, { isError: true, data: undefined, error: { status: 403 } })).toMatchObject({
      failed: false,
      blockPick: false,
    });
  });

  it("a CUSTOMER read 403 still fails closed", () => {
    expect(
      gate({ isError: true, data: undefined, error: err(403) }, { isError: false, data: [] }),
    ).toMatchObject({ failed: true, readFailed: true, blockPick: true });
  });
});
