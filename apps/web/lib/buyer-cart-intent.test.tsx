import { act, renderHook } from "@testing-library/react";
import { useBuyerCartForceNew, FORCE_NEW_TTL_MS } from "./buyer-cart-intent";

// Row 604 review S8: the "create new order instead" choice must expire and follow the cart.
const KEY = "buyerCartForceNew_b1_acme";

beforeEach(() => localStorage.clear());

describe("useBuyerCartForceNew", () => {
  it("a fresh choice is read back after a remount", () => {
    localStorage.setItem(KEY, String(Date.now() - 1000));
    const { result } = renderHook(() => useBuyerCartForceNew("b1", "acme", 2));
    expect(result.current[0]).toBe(true);
  });

  it("a choice older than the TTL is ignored and removed", () => {
    localStorage.setItem(KEY, String(Date.now() - FORCE_NEW_TTL_MS - 1000));
    const { result } = renderHook(() => useBuyerCartForceNew("b1", "acme", 2));
    expect(result.current[0]).toBe(false);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("the legacy never-expiring value ('1') is treated as expired", () => {
    localStorage.setItem(KEY, "1");
    const { result } = renderHook(() => useBuyerCartForceNew("b1", "acme", 2));
    expect(result.current[0]).toBe(false);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("setting the choice stores a timestamp, not a bare flag", () => {
    const { result } = renderHook(() => useBuyerCartForceNew("b1", "acme", 2));
    act(() => result.current[1](true));
    expect(Number(localStorage.getItem(KEY))).toBeGreaterThan(1_000_000_000_000);
  });

  it("the choice is cleared when the cart becomes empty", () => {
    localStorage.setItem(KEY, String(Date.now()));
    const { result, rerender } = renderHook(
      ({ n }: { n: number }) => useBuyerCartForceNew("b1", "acme", n),
      { initialProps: { n: 2 } },
    );
    expect(result.current[0]).toBe(true);
    rerender({ n: 0 });
    expect(result.current[0]).toBe(false);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("an empty cart on first render (before it hydrates) does not clear a fresh choice", () => {
    localStorage.setItem(KEY, String(Date.now()));
    const { result } = renderHook(() => useBuyerCartForceNew("b1", "acme", 0));
    expect(result.current[0]).toBe(true);
  });
});
