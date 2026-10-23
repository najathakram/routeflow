import * as React from "react";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TestRenderer: any = require("react-test-renderer");
const { act } = TestRenderer;

import { useCustomerPickGate } from "../components/new-order/use-customer-pick-gate";
import {
  guardLayerSave,
  LAYER_FAILED_MESSAGE,
  LAYER_PENDING_MESSAGE,
} from "../lib/price-layer-gate";
import { PICK_PENDING_NOTICE_DELAY_MS } from "../lib/customer-pick-gate";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * SA-887 LOW (#3665): a render case. The builders' gate hook, mounted: a line was picked while the reads were fine, then the
 * customer-price read FAILS with no data. Tapping Create runs onSave's guard on `pick.saveGate(items, layerGate)`: it must
 * refuse with the failed copy (the cart sheet's Create reads the same gate), and Retry must refetch both reads.
 */
const off = {
  enabled: false,
  ready: true,
  failed: false,
  lineReady: () => true,
  refetch: jest.fn(),
};
const layerOpen = { blocked: false, message: null, canRetry: false };
type Hook = ReturnType<typeof useCustomerPickGate>;

function mount(customer: Record<string, unknown>, prices: Record<string, unknown>) {
  const seen: { current?: Hook } = {};
  const refetch = { customer: jest.fn(), prices: jest.fn() };
  function Probe({ c, p }: { c: Record<string, unknown>; p: Record<string, unknown> }) {
    seen.current = useCustomerPickGate(
      "c1",
      { ...c, refetch: refetch.customer },
      { ...p, refetch: refetch.prices },
      off,
    );
    return null;
  }
  let root: any;
  act(() => {
    root = TestRenderer.create(React.createElement(Probe, { c: customer, p: prices }));
  });
  return {
    seen,
    refetch,
    rerender: (c: Record<string, unknown>, p: Record<string, unknown>) =>
      act(() => root.update(React.createElement(Probe, { c, p }))),
  };
}

describe("SA-887: Create after a forced read failure (render)", () => {
  afterEach(() => jest.useRealTimers());

  it("a picked line, then the prices read fails with no data: Create refuses with the failed copy; Retry refetches", () => {
    const h = mount({ data: { pricingTier: 3 } }, { data: [] });
    const items = { p1: {} }; // picked from the catalogue, no operator-typed price
    expect(guardLayerSave(h.seen.current!.saveGate(items, layerOpen), false)).toBeNull(); // Create goes through
    h.rerender(
      { data: { pricingTier: 3 } },
      { isError: true, data: undefined, error: { response: { status: 500 } } },
    );
    const onCreate = () => guardLayerSave(h.seen.current!.saveGate(items, layerOpen), false);
    expect(onCreate()).toBe(LAYER_FAILED_MESSAGE);
    expect(h.seen.current!.blocksSave(items)).toBe(true);
    h.seen.current!.retry();
    expect(h.refetch.customer).toHaveBeenCalled(); // a failed customer-side read refetches both reads
    expect(h.refetch.prices).toHaveBeenCalled();
  });

  it("a PLAN_GATE 403 on the prices read: the pick and Create both go through", () => {
    const h = mount(
      { data: { pricingTier: 3 } },
      {
        isError: true,
        data: undefined,
        error: { response: { status: 403, data: { code: "PLAN_GATE" } } },
      },
    );
    expect(h.seen.current!.refusal).toBeNull();
    expect(guardLayerSave(h.seen.current!.saveGate({ p1: {} }, layerOpen), false)).toBeNull();
  });

  it("pending: the notice turns on only after the delay", () => {
    jest.useFakeTimers();
    const h = mount({ isPending: true }, { isPending: true });
    expect(h.seen.current!.refusal).toBe(LAYER_PENDING_MESSAGE);
    expect(h.seen.current!.notice.message).toBeNull();
    act(() => {
      jest.advanceTimersByTime(PICK_PENDING_NOTICE_DELAY_MS);
    });
    expect(h.seen.current!.notice.message).toBe(LAYER_PENDING_MESSAGE);
  });
});
