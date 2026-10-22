import * as React from "react";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TestRenderer: any = require("react-test-renderer");
const { act } = TestRenderer;

jest.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));
jest.mock("../lib/api/payment-by-key", () => ({ resolvePaymentByKey: jest.fn() }));

import { createPaymentKeyHolder } from "../lib/payment-submit-key";
import { useHolderUnknown } from "../lib/use-payment-status-check";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * SA-824: "unknown" on a record-payment screen or sheet. A request already out when the screen is OPENED is
 * unknown (Save off, "Check payment status" offered); the screen's own Save is not. The decision is taken on
 * every open and ends with the inherited flight, never once per mount.
 */
const pay = { amount: 100, method: "CASH" };
const mintSeq = () => {
  let n = 0;
  return () => `key-${++n}`;
};
const err503 = Object.assign(new Error("x"), { response: { status: 503, data: {} } });

function mountHook(holder: ReturnType<typeof createPaymentKeyHolder>, open: boolean) {
  const seen: { current: boolean } = { current: false };
  function Probe({ isOpen }: { isOpen: boolean }) {
    seen.current = useHolderUnknown(holder, isOpen);
    return null;
  }
  let root: any;
  act(() => {
    root = TestRenderer.create(React.createElement(Probe, { isOpen: open }));
  });
  return {
    seen,
    setOpen: (isOpen: boolean) =>
      act(() => {
        root.update(React.createElement(Probe, { isOpen }));
      }),
  };
}

describe("useHolderUnknown (mobile)", () => {
  it("a screen that stays mounted recomputes on open: a request already out is unknown", () => {
    const h = createPaymentKeyHolder(mintSeq());
    const view = mountHook(h, false);
    act(() => void h.keyFor(pay));
    view.setOpen(true);
    expect(view.seen.current).toBe(true);
  });

  it("'inherited' ends with the inherited flight; the screen's own Save is not unknown", () => {
    const h = createPaymentKeyHolder(mintSeq());
    let other = "";
    act(() => {
      other = h.keyFor(pay);
    });
    const view = mountHook(h, true);
    expect(view.seen.current).toBe(true);
    act(() => h.settle(other, { ok: true }));
    expect(view.seen.current).toBe(false);
    let own = "";
    act(() => {
      own = h.keyFor(pay);
    });
    expect(view.seen.current).toBe(false);
    act(() => h.settle(own, { ok: false, error: err503 }));
    expect(view.seen.current).toBe(true);
  });
});
