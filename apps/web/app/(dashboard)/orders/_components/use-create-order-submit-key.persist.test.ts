import { renderHook } from "@testing-library/react";
import { useCreateOrderSubmitKey } from "./use-create-order-submit-key";

// SA-817 (A) 4 / A6: the create key is no longer private to the modal instance. The draft carries it (peek), a resumed draft
// brings its own (adopt), and every re-mint is announced (onChange) so the draft can carry the new one.

describe("create-order submit key, persisted with the draft (SA-817 A6)", () => {
  it("A6: peek() is the key the next attempt would send", () => {
    const { result } = renderHook(() => useCreateOrderSubmitKey(true));
    const key = result.current.peek();
    expect(key).toEqual(expect.any(String));
    expect(result.current.begin("cart-1")).toBe(key);
  });

  it("A6: a resumed draft's key is adopted, and the next attempt sends exactly that key", () => {
    const onChange = jest.fn();
    const { result } = renderHook(() => useCreateOrderSubmitKey(true, onChange));
    result.current.adopt("K-FROM-DRAFT");
    expect(result.current.peek()).toBe("K-FROM-DRAFT");
    expect(onChange).toHaveBeenLastCalledWith("K-FROM-DRAFT");
    expect(result.current.begin("cart-1")).toBe("K-FROM-DRAFT");
  });

  it("A6: after a reload the cart may be edited before the resubmit: the adopted key is KEPT (the earlier attempt may have been written)", () => {
    const { result } = renderHook(() => useCreateOrderSubmitKey(true));
    result.current.adopt("K-FROM-DRAFT");
    expect(result.current.begin("cart-1")).toBe("K-FROM-DRAFT");
    result.current.settle("unknown");
    expect(result.current.begin("cart-2")).toBe("K-FROM-DRAFT");
    result.current.settle("refused"); // a 4xx on the retry proves only that the retry wrote nothing
    expect(result.current.peek()).toBe("K-FROM-DRAFT");
  });

  it("a 2xx re-mints the key and announces it, so the draft carries the new one", () => {
    const onChange = jest.fn();
    const { result } = renderHook(() => useCreateOrderSubmitKey(true, onChange));
    result.current.adopt("K-FROM-DRAFT");
    result.current.begin("cart-1");
    onChange.mockClear();
    result.current.settle("success");
    expect(result.current.peek()).not.toBe("K-FROM-DRAFT");
    expect(onChange).toHaveBeenCalledWith(result.current.peek());
  });

  it("a plain cart edit with nothing in flight re-mints (unchanged BUG-A rule) and announces it", () => {
    const onChange = jest.fn();
    const { result } = renderHook(() => useCreateOrderSubmitKey(true, onChange));
    const first = result.current.begin("cart-1");
    result.current.settle("same-attempt");
    onChange.mockClear();
    const second = result.current.begin("cart-2");
    expect(second).not.toBe(first);
    expect(onChange).toHaveBeenCalledWith(second);
  });

  it("opening the modal announces the freshly minted key", () => {
    const onChange = jest.fn();
    renderHook(() => useCreateOrderSubmitKey(true, onChange));
    expect(onChange).toHaveBeenCalledWith(expect.any(String));
  });
});
