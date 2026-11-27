import * as React from "react";
import { act, renderHook } from "@testing-library/react";
import { useBuyerCart, type CartItem } from "./buyer-cart";

/**
 * B1409 (R-200 LOW-1): a state updater must be pure, because React may run it twice (StrictMode). The limit line is
 * said once per clamping Add, from an effect after the commit. The toast function is spied directly: the real
 * ToastProvider queues inside its own updater, which StrictMode would double on its own.
 */
const toast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({ useOptionalToast: () => ({ toast }) }));

const plain = (qty: number): CartItem => ({
  productId: "p1",
  name: "Widget",
  unit: "each",
  unitsPerBox: null,
  qty,
});
const strict = ({ children }: { children: React.ReactNode }) => (
  <React.StrictMode>{children}</React.StrictMode>
);

beforeEach(() => {
  localStorage.clear();
  toast.mockClear();
});

describe("useBuyerCart.addItem under a double-invoked updater (B1409)", () => {
  it("a merge that clamps says the limit line exactly once", () => {
    const { result } = renderHook(() => useBuyerCart("b1", "acme"), { wrapper: strict });
    act(() => result.current.addItem(plain(100_000)));
    act(() => result.current.addItem(plain(1)));
    expect(result.current.items[0].qty).toBe(100_000);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0].title).toBe("The most you can order at once is 100,000.");
  });

  it("a new line over the cap says it exactly once", () => {
    const { result } = renderHook(() => useBuyerCart("b1", "acme"), { wrapper: strict });
    act(() => result.current.addItem(plain(120_000)));
    expect(result.current.items[0].qty).toBe(100_000);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("an Add below the cap says nothing", () => {
    const { result } = renderHook(() => useBuyerCart("b1", "acme"), { wrapper: strict });
    act(() => result.current.addItem(plain(5)));
    expect(toast).not.toHaveBeenCalled();
  });
});
