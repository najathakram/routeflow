import { act, renderHook } from "@testing-library/react";
import { useUrlSearch } from "./useUrlSearch";

/**
 * UX audit 2026-11-24, finding F49: a space typed (or pasted) in front of a search term reached the server as part of
 * the term, so " acme" found nothing on orders, customers, products and invoices. The term a list queries with, and the
 * one written to the URL, is trimmed in the shared hook; the box keeps the typed text.
 */
jest.mock("next/navigation", () => ({
  usePathname: () => "/orders",
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

beforeEach(() => {
  jest.useFakeTimers();
  window.history.replaceState(null, "", "/orders");
});
afterEach(() => jest.useRealTimers());

const settle = () =>
  act(() => {
    jest.advanceTimersByTime(300);
  });

describe("useUrlSearch: the queried term is trimmed", () => {
  it("a leading space is not part of the term the list queries with", () => {
    const { result } = renderHook(() => useUrlSearch());
    act(() => result.current[1](" acme"));
    settle();
    expect(result.current[2]).toBe("acme");
  });

  it("the URL carries the trimmed term, so Back and reload restore it clean", () => {
    const { result } = renderHook(() => useUrlSearch());
    act(() => result.current[1]("  acme cafe  "));
    settle();
    expect(new URLSearchParams(window.location.search).get("search")).toBe("acme cafe");
  });

  it("the box keeps what was typed: a space between two words is not eaten mid-typing", () => {
    const { result, rerender } = renderHook(() => useUrlSearch());
    act(() => result.current[1]("acme "));
    settle();
    rerender();
    expect(result.current[0]).toBe("acme ");
    expect(result.current[2]).toBe("acme");
  });

  it("only spaces is no search at all: no term, no param", () => {
    const { result } = renderHook(() => useUrlSearch());
    act(() => result.current[1]("   "));
    settle();
    expect(result.current[2]).toBe("");
    expect(window.location.search).toBe("");
  });

  it("a filter already in the URL survives the search write", () => {
    window.history.replaceState(null, "", "/orders?status=PENDING");
    const { result } = renderHook(() => useUrlSearch());
    act(() => result.current[1](" acme"));
    settle();
    const q = new URLSearchParams(window.location.search);
    expect(q.get("status")).toBe("PENDING");
    expect(q.get("search")).toBe("acme");
  });
});
