import { act, renderHook } from "@testing-library/react";
import { useUrlSort } from "./useUrlSort";

/**
 * UX audit 2026-11-24, finding F50: the orders list kept its filter after Back from an order but dropped the sort,
 * because the sort was component state. It is read from `?sort=` / `?dir=` now.
 */
jest.mock("next/navigation", () => ({
  usePathname: () => "/orders",
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

const COLS = ["createdAt", "total", "customer"] as const;
const useSort = () => useUrlSort(COLS, "createdAt", "desc");
const query = () => new URLSearchParams(window.location.search);

beforeEach(() => window.history.replaceState(null, "", "/orders"));

describe("useUrlSort", () => {
  it("no params reads as the default sort", () => {
    const { result } = renderHook(useSort);
    expect([result.current[0], result.current[1]]).toEqual(["createdAt", "desc"]);
  });

  it("a sort already in the URL (Back from a row, a reload) is the sort the list shows", () => {
    window.history.replaceState(null, "", "/orders?sort=total&dir=asc");
    const { result } = renderHook(useSort);
    expect([result.current[0], result.current[1]]).toEqual(["total", "asc"]);
  });

  it("setting a sort writes both params and the next render reads them", () => {
    const { result, rerender } = renderHook(useSort);
    act(() => result.current[2]("total", "asc"));
    expect(query().get("sort")).toBe("total");
    expect(query().get("dir")).toBe("asc");
    rerender();
    expect([result.current[0], result.current[1]]).toEqual(["total", "asc"]);
  });

  it("going back to the default removes both params", () => {
    window.history.replaceState(null, "", "/orders?sort=total&dir=asc");
    const { result } = renderHook(useSort);
    act(() => result.current[2]("createdAt", "desc"));
    expect(window.location.search).toBe("");
  });

  it("the default column in the other direction is still written", () => {
    const { result } = renderHook(useSort);
    act(() => result.current[2]("createdAt", "asc"));
    expect(query().get("sort")).toBe("createdAt");
    expect(query().get("dir")).toBe("asc");
  });

  it("an unknown column in the URL reads as the default, direction included", () => {
    window.history.replaceState(null, "", "/orders?sort=secret&dir=asc");
    const { result } = renderHook(useSort);
    expect([result.current[0], result.current[1]]).toEqual(["createdAt", "desc"]);
  });

  it("a bad direction on a known column falls back to the default direction", () => {
    window.history.replaceState(null, "", "/orders?sort=total&dir=sideways");
    const { result } = renderHook(useSort);
    expect([result.current[0], result.current[1]]).toEqual(["total", "desc"]);
  });

  it("a sort write keeps the filters, the search and the page that are in the URL", () => {
    window.history.replaceState(null, "", "/orders?status=PENDING&search=acme&page=3");
    const { result } = renderHook(useSort);
    act(() => result.current[2]("customer", "asc"));
    const q = query();
    expect(q.get("status")).toBe("PENDING");
    expect(q.get("search")).toBe("acme");
    expect(q.get("page")).toBe("3");
    expect(q.get("sort")).toBe("customer");
  });
});
