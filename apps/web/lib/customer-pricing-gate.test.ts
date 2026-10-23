import { customerPricingGate, gateNoticeLayer } from "./customer-pricing-gate";

/** W-745 / SA-890 LOW: what PriceLayerNotice shows for the whole gate. */
const refetch = jest.fn();
const layer = (o: Partial<{ enabled: boolean; ready: boolean; failed: boolean }>) => ({
  enabled: false,
  ready: true,
  pending: false,
  failed: false,
  refetch: jest.fn(),
  lineReady: () => true,
  ...o,
});
const gate = (customer: Record<string, unknown>, l: ReturnType<typeof layer>) =>
  customerPricingGate({
    customerQuery: customer,
    customerPricesQuery: { data: [] },
    priceLayer: l,
  });

describe("gateNoticeLayer", () => {
  it("a failed customer read: the failed notice, whose Retry refetches the reads", () => {
    const l = layer({ enabled: true });
    const n = gateNoticeLayer(gate({ isError: true, data: undefined }, l), l, refetch);
    expect(n).toMatchObject({ enabled: true, failed: true });
    n.refetch();
    expect(refetch).toHaveBeenCalled();
  });

  it("flag ON, layer ready, customer read still pending: the PENDING copy, not the layer's (SA-890 LOW)", () => {
    const l = layer({ enabled: true, ready: true });
    expect(gateNoticeLayer(gate({ isPending: true }, l), l, refetch)).toMatchObject({
      enabled: true,
      ready: false,
      pending: true,
      failed: false,
    });
  });

  it("flag ON, the layer itself still being read: the layer answers", () => {
    const l = layer({ enabled: true, ready: false });
    expect(gateNoticeLayer(gate({ data: {} }, l), l, refetch)).toBe(l);
  });

  it("everything read: the layer as is", () => {
    const l = layer({});
    expect(gateNoticeLayer(gate({ data: {} }, l), l, refetch)).toBe(l);
  });
});
