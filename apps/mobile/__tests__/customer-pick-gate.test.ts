import { customerPricingGate } from "@routeflow/pricing";
import {
  PICK_PENDING_NOTICE_DELAY_MS,
  customerPickNotice,
  customerPickRefusal,
  retryCustomerPricing,
} from "../lib/customer-pick-gate";
import { LAYER_FAILED_MESSAGE, LAYER_PENDING_MESSAGE } from "../lib/price-layer-gate";

/**
 * W-741 (W-725 follow-up, SA-868): NewOrderScreen and invoices/new let a product be picked while the customer or
 * customer-price read was still loading or had FAILED with no data, so the pick priced at tier 1 (LIST). The pick now fails
 * closed through the shared `customerPricingGate`: a pick is refused with the pending or failed copy, a failed read offers
 * Retry, and the pending notice appears only after a short delay so a fast read never flashes.
 */
const off = { enabled: false, ready: true, failed: false, lineReady: () => true };
const gate = (customer: Record<string, unknown>, prices: Record<string, unknown> = { data: [] }) =>
  customerPricingGate({ customerQuery: customer, customerPricesQuery: prices, priceLayer: off });
const read = { data: { id: "c1", pricingTier: 3 } };

describe("W-741: a pick fails closed on an unread customer price", () => {
  it("everything read: the pick goes through and nothing shows", () => {
    expect(customerPickRefusal(gate(read), "c1")).toBeNull();
    expect(customerPickNotice(gate(read), "c1", true).message).toBeNull();
  });

  it("no customer chosen yet: nothing to gate", () => {
    expect(customerPickRefusal(gate({ isPending: true }), null)).toBeNull();
    expect(customerPickNotice(gate({ isPending: true }), null, true).message).toBeNull();
  });

  it("a read still loading refuses the pick with the pending copy", () => {
    expect(customerPickRefusal(gate({ isPending: true }), "c1")).toBe(LAYER_PENDING_MESSAGE);
  });

  it("a read paused offline (pending, not loading) refuses like a loading one", () => {
    expect(customerPickRefusal(gate(read, { isPending: true, isLoading: false }), "c1")).toBe(
      LAYER_PENDING_MESSAGE,
    );
  });

  it("a read that FAILED with no data refuses with the failed copy and offers Retry", () => {
    const g = gate({ isError: true, data: undefined });
    expect(customerPickRefusal(g, "c1")).toBe(LAYER_FAILED_MESSAGE);
    expect(customerPickNotice(g, "c1", false)).toEqual({
      blocked: true,
      message: LAYER_FAILED_MESSAGE,
      canRetry: true,
    });
  });

  it("an error WITH data (a stale refetch) does not block", () => {
    expect(customerPickRefusal(gate({ ...read, isError: true }), "c1")).toBeNull();
  });

  it("the pending notice waits for the delay so a fast read never flashes", () => {
    expect(PICK_PENDING_NOTICE_DELAY_MS).toBeGreaterThan(0);
    expect(PICK_PENDING_NOTICE_DELAY_MS).toBeLessThanOrEqual(600);
    const pending = gate({ isPending: true });
    expect(customerPickNotice(pending, "c1", false).message).toBeNull();
    expect(customerPickNotice(pending, "c1", true)).toEqual({
      blocked: true,
      message: LAYER_PENDING_MESSAGE,
      canRetry: false,
    });
  });

  it("Retry refetches the failed customer reads, else the price layer", () => {
    const deps = { refetchCustomer: jest.fn(), refetchPrices: jest.fn(), refetchLayer: jest.fn() };
    retryCustomerPricing(gate({ isError: true, data: undefined }), deps);
    expect(deps.refetchCustomer).toHaveBeenCalled();
    expect(deps.refetchPrices).toHaveBeenCalled();
    expect(deps.refetchLayer).not.toHaveBeenCalled();
    const layerFailed = customerPricingGate({
      customerQuery: read,
      customerPricesQuery: { data: [] },
      priceLayer: { enabled: true, ready: false, failed: true, lineReady: () => false },
    });
    const d2 = { refetchCustomer: jest.fn(), refetchPrices: jest.fn(), refetchLayer: jest.fn() };
    retryCustomerPricing(layerFailed, d2);
    expect(d2.refetchLayer).toHaveBeenCalled();
    expect(d2.refetchCustomer).not.toHaveBeenCalled();
  });
});

describe("W-741: both builders route every pick through the gate", () => {
  const { readFileSync } = jest.requireActual<typeof import("fs")>("fs");
  const { join } = jest.requireActual<typeof import("path")>("path");
  const screens = {
    NewOrderScreen: readFileSync(join(__dirname, "../components/NewOrderScreen.tsx"), "utf8"),
    "invoices/new": readFileSync(
      join(__dirname, "../app/(operator)/(tabs)/invoices/new.tsx"),
      "utf8",
    ),
  };
  it.each(Object.entries(screens))(
    "%s: the add choke point, the scan accept and the notice",
    (_, src) => {
      expect(src).toMatch(
        /const pick = useCustomerPickGate\(customerId, customerQuery, pricesQuery, priceLayer\)/,
      );
      // addOne (scan, tap and row add all land here) refuses first, before any price is read
      expect(src).toMatch(
        /const addOne = \([\s\S]*?\): boolean => \{\s*if \(pick\.refusal\) return \(showToast\(pick\.refusal\), false\);/,
      );
      // a refused scan shows ONE message, the gate's own copy
      expect(src).toMatch(
        /if \(pick\.refusal\) return refusedScanOutcome\(scanOpen, pick\.refusal\);\s*(\/\/[^\n]*\n\s*)?if \(!addOne\(/,
      );
      expect(src).toMatch(/onRetry=\{[^}]*pick\.retry/);
    },
  );
});
