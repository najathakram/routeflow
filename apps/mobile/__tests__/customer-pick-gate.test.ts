import { customerPricingGate } from "@routeflow/pricing";
import {
  PICK_PENDING_NOTICE_DELAY_MS,
  builderSaveBlocked,
  builderSaveGate,
  hasOpenSuggestion,
  customerPickNotice,
  customerPickRefusal,
  retryCustomerPricing,
} from "../lib/customer-pick-gate";
import {
  LAYER_FAILED_MESSAGE,
  LAYER_PENDING_MESSAGE,
  guardLayerSave,
} from "../lib/price-layer-gate";

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
      // a refused row tap keeps the operator's search (it used to clear it, so the results vanished)
      expect(src).toMatch(
        /const onRowAdd = useCallback\(\(id: string\) => \{\s*if \(actionsRef\.current\.add\(id\)\) actionsRef\.current\.pickedFromSearch\(id\);/,
      );
    },
  );
});

/**
 * SA-883 (2) on #3665: Create/Save on both builders also waits on the gate's blockSave. A line picked while the read was fine
 * whose read then FAILS with no data (a customer change, a cleared cache) is an open suggestion priced at LIST: Create stays
 * disabled until the read is back or the operator types the price.
 */
describe("SA-883: Create/Save waits on blockSave", () => {
  const failed = { isError: true, data: undefined };
  const save = (items: Record<string, { unitPrice?: number }>, customer: Record<string, unknown>) =>
    builderSaveBlocked(
      customerPricingGate({
        customerQuery: customer,
        customerPricesQuery: { data: [] },
        priceLayer: off,
        productIds: Object.keys(items),
        openSuggestions: hasOpenSuggestion(items),
      }),
      "c1",
    );

  it("a picked line (no typed price), then the read fails with no data: Create is disabled", () => {
    expect(save({ p1: {} }, failed)).toBe(true);
  });
  it("the same line with an operator-typed price: Create is allowed", () => {
    expect(save({ p1: { unitPrice: 4.5 } }, failed)).toBe(false);
  });
  it("everything read: Create is allowed", () => {
    expect(save({ p1: {} }, read)).toBe(false);
  });
  it("no customer (walk-in): never blocked by the customer gate", () => {
    const g = customerPricingGate({
      customerQuery: { isPending: true },
      customerPricesQuery: {},
      priceLayer: off,
    });
    expect(builderSaveBlocked(g, null)).toBe(false);
  });
  it.each(["components/NewOrderScreen.tsx", "app/(operator)/(tabs)/invoices/new.tsx"])(
    "%s: canSave checks pick.blocksSave(items)",
    (rel) => {
      const { readFileSync } = jest.requireActual<typeof import("fs")>("fs");
      const { join } = jest.requireActual<typeof import("path")>("path");
      expect(readFileSync(join(__dirname, "..", rel), "utf8")).toMatch(
        /const canSave =[^;]*!pick\.blocksSave\(items\)/,
      );
    },
  );
});

describe("#3665 review NIT: the create-on-miss add stops when the add is refused", () => {
  it.each(["components/NewOrderScreen.tsx", "app/(operator)/(tabs)/invoices/new.tsx"])(
    "%s",
    (rel) => {
      const { readFileSync } = jest.requireActual<typeof import("fs")>("fs");
      const { join } = jest.requireActual<typeof import("path")>("path");
      const src = readFileSync(join(__dirname, "..", rel), "utf8");
      expect(src).toMatch(/if \(!addOne\(product\.id, snapshot\)\) return;/);
      expect(src).not.toMatch(/^\s*addOne\(product\.id, snapshot\);/m);
    },
  );
});

/**
 * #3665 delta review MUST: the CART SHEET's Create/Confirm and onSave read only the layer gate, so after a picked line and a
 * failed prices read the footer Create was held but the cart's Create still submitted. Both now read ONE save gate: the layer
 * gate, widened by blocksSave, with a message to alert and a Retry that refetches the failed reads.
 */
describe("#3665: one save gate for the footer, the cart sheet and onSave", () => {
  const layerOpen = { blocked: false, message: null, canRetry: false };
  const failedGate = customerPricingGate({
    customerQuery: { isError: true, data: undefined },
    customerPricesQuery: { data: [] },
    priceLayer: off,
    productIds: ["p1"],
    openSuggestions: true,
  });

  it("a failed read with an open suggestion blocks with the failed copy and offers Retry", () => {
    expect(builderSaveGate(failedGate, "c1", layerOpen)).toEqual({
      blocked: true,
      message: LAYER_FAILED_MESSAGE,
      canRetry: true,
    });
    expect(guardLayerSave(builderSaveGate(failedGate, "c1", layerOpen), false)).toBe(
      LAYER_FAILED_MESSAGE,
    );
    expect(guardLayerSave(builderSaveGate(failedGate, "c1", layerOpen), true)).toBeNull(); // a draft is never gated
  });

  it("the layer's own block keeps its message", () => {
    const layer = { blocked: true, message: "Checking this customer's prices…", canRetry: false };
    expect(builderSaveGate(gate(read), "c1", layer)).toBe(layer);
  });

  it("nothing blocks: the layer gate as is", () => {
    expect(builderSaveGate(gate(read), "c1", layerOpen)).toBe(layerOpen);
  });

  it("a PLAN_GATE 403 on the prices read (un-flagged plan): pick and Create both allowed", () => {
    const planGated = customerPricingGate({
      customerQuery: read,
      customerPricesQuery: {
        isError: true,
        data: undefined,
        error: { response: { status: 403, data: { code: "PLAN_GATE" } } },
      },
      priceLayer: off,
      productIds: ["p1"],
      openSuggestions: true,
    });
    expect(customerPickRefusal(planGated, "c1")).toBeNull();
    expect(builderSaveGate(planGated, "c1", layerOpen).blocked).toBe(false);
  });

  it.each([
    [
      "components/NewOrderScreen.tsx",
      /guardLayerSave\(pick\.saveGate\(items, layerGate\), asDraft\)/,
    ],
    [
      "components/NewOrderScreen.tsx",
      /layerGate=\{pick\.saveGate\(items, layerGate\)\}\s*onRetryLayer=\{pick\.retry\}/,
    ],
    [
      "app/(operator)/(tabs)/invoices/new.tsx",
      /guardLayerSave\(pick\.saveGate\(items, layerGate\), false\)/,
    ],
  ])("%s wires the save gate (%s)", (rel, re) => {
    const { readFileSync } = jest.requireActual<typeof import("fs")>("fs");
    const { join } = jest.requireActual<typeof import("path")>("path");
    expect(readFileSync(join(__dirname, "..", rel), "utf8")).toMatch(re);
  });
});
