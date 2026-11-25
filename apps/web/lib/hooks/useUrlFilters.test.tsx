import { act, renderHook } from "@testing-library/react";
import { useUrlFilters } from "./useUrlFilters";

/**
 * Row 729: two filter writes landing less than ~150 ms apart lost the first, because `setFilter` built its query from
 * the `searchParams` of the render it was created in, and `router.replace` had not yet committed the first write into the
 * URL. Each write now starts from the latest URL it knows of, including a write still on its way.
 */
let currentQuery = "";
const replace = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/orders",
  useSearchParams: () => new URLSearchParams(currentQuery),
}));

const DEFAULTS = { status: "", urgent: false, fulfillPath: "", dateFrom: "", dateTo: "" };
const lastQuery = () => new URLSearchParams(String(replace.mock.calls.at(-1)![0]).split("?")[1]);

beforeEach(() => {
  jest.useFakeTimers();
  currentQuery = "";
  replace.mockReset();
});
afterEach(() => jest.useRealTimers());

describe("useUrlFilters: quick successive writes (row 729)", () => {
  it("setFilter then setFilter 100 ms later keeps BOTH, though the URL has not caught up", () => {
    const { result } = renderHook(() => useUrlFilters(DEFAULTS));
    act(() => result.current[1]("urgent", true));
    act(() => {
      jest.advanceTimersByTime(100);
    });
    act(() => result.current[1]("fulfillPath", "ROUTE"));
    const q = lastQuery();
    expect(q.get("urgent")).toBe("1");
    expect(q.get("fulfillPath")).toBe("ROUTE");
  });

  it("two writes in the same tick (a stale closure from one render) keep both", () => {
    const { result } = renderHook(() => useUrlFilters(DEFAULTS));
    const setFilter = result.current[1];
    act(() => {
      setFilter("urgent", true);
      setFilter("status", "DRAFT");
    });
    const q = lastQuery();
    expect(q.get("urgent")).toBe("1");
    expect(q.get("status")).toBe("DRAFT");
  });

  it("setFilter then setFilters (several keys) then clear keep composing on the latest write", () => {
    const { result } = renderHook(() => useUrlFilters(DEFAULTS));
    act(() => result.current[1]("urgent", true));
    act(() => result.current[3]({ dateFrom: "2026-10-01", dateTo: "2026-10-09" }));
    let q = lastQuery();
    expect([q.get("urgent"), q.get("dateFrom"), q.get("dateTo")]).toEqual([
      "1",
      "2026-10-01",
      "2026-10-09",
    ]);
    act(() => result.current[1]("urgent", false));
    q = lastQuery();
    expect(q.get("urgent")).toBeNull();
    expect(q.get("dateFrom")).toBe("2026-10-01");
  });

  it("once the URL has caught up, the next write starts from the URL (a back/forward or other writer wins)", () => {
    const { result, rerender } = renderHook(() => useUrlFilters(DEFAULTS));
    act(() => result.current[1]("urgent", true));
    currentQuery = "status=PENDING"; // the URL moved somewhere else entirely
    rerender();
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    act(() => result.current[1]("fulfillPath", "SHIP"));
    const q = lastQuery();
    expect(q.get("status")).toBe("PENDING");
    expect(q.get("fulfillPath")).toBe("SHIP");
    expect(q.get("urgent")).toBeNull();
  });

  // The lead's ruling on row 729: a browser Back inside the pending window must not be overwritten by the write in flight.
  it("Back, then a write inside the window, builds on the post-Back URL (popstate clears the pending write)", () => {
    currentQuery = "status=PENDING";
    const { result, rerender } = renderHook(() => useUrlFilters(DEFAULTS));
    act(() => result.current[1]("urgent", true)); // in flight: status=PENDING&urgent=1
    act(() => {
      jest.advanceTimersByTime(300);
    });
    // the person presses Back: the browser fires popstate, then Next hands us the previous URL
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    currentQuery = "";
    rerender();
    act(() => {
      jest.advanceTimersByTime(100);
    });
    act(() => result.current[1]("fulfillPath", "SHIP"));
    const q = lastQuery();
    expect(q.get("fulfillPath")).toBe("SHIP");
    expect(q.get("urgent")).toBeNull(); // the pre-Back write is not resurrected
    expect(q.get("status")).toBeNull();
  });

  it("after Back, quick writes still compose with each other", () => {
    const { result, rerender } = renderHook(() => useUrlFilters(DEFAULTS));
    act(() => result.current[1]("urgent", true));
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    currentQuery = "";
    rerender();
    act(() => result.current[1]("fulfillPath", "SHIP"));
    act(() => {
      jest.advanceTimersByTime(100);
    });
    act(() => result.current[1]("status", "DRAFT"));
    const q = lastQuery();
    expect([q.get("fulfillPath"), q.get("status"), q.get("urgent")]).toEqual([
      "SHIP",
      "DRAFT",
      null,
    ]);
  });

  it("stops listening for Back on unmount", () => {
    const spy = jest.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useUrlFilters(DEFAULTS));
    unmount();
    expect(spy).toHaveBeenCalledWith("popstate", expect.any(Function));
    spy.mockRestore();
  });

  it("an unrelated param already in the URL is kept, and page resets", () => {
    currentQuery = "action=new&page=3";
    const { result } = renderHook(() => useUrlFilters(DEFAULTS));
    act(() => result.current[1]("urgent", true));
    act(() => result.current[1]("status", "DRAFT"));
    const q = lastQuery();
    expect(q.get("action")).toBe("new");
    expect(q.get("page")).toBeNull();
    expect([q.get("urgent"), q.get("status")]).toEqual(["1", "DRAFT"]);
  });
});

/**
 * R-137: `writeParams` is the page's one way to change the query by hand. The orders sort and its "Clear filters"
 * button go through it, so a filter and the sort never leave as two URL writes.
 */
describe("useUrlFilters: writeParams, the one writer other URL state shares", () => {
  const setSort = (p: URLSearchParams) => {
    p.set("sort", "total");
    p.set("dir", "asc");
  };

  it("a filter write, then a sort inside the pending window, then another filter: all three survive", () => {
    const { result } = renderHook(() => useUrlFilters(DEFAULTS));
    act(() => result.current[1]("urgent", true));
    act(() => {
      jest.advanceTimersByTime(100);
    });
    act(() => result.current[4](setSort, { keepPage: true }));
    act(() => {
      jest.advanceTimersByTime(100);
    });
    act(() => result.current[1]("fulfillPath", "ROUTE"));
    expect(lastQuery().toString()).toBe("urgent=1&sort=total&dir=asc&fulfillPath=ROUTE");
  });

  it("keepPage leaves the page where it is; without it the page resets", () => {
    currentQuery = "page=3";
    const { result } = renderHook(() => useUrlFilters(DEFAULTS));
    act(() => result.current[4](setSort, { keepPage: true }));
    expect(lastQuery().toString()).toBe("page=3&sort=total&dir=asc");
    act(() => result.current[4]((p) => p.delete("sort")));
    expect(lastQuery().toString()).toBe("dir=asc");
  });

  it("several params removed together leave as ONE replace", () => {
    currentQuery = "urgent=1&dateFrom=2026-10-01&sort=total&dir=asc&status=DRAFT";
    const { result } = renderHook(() => useUrlFilters(DEFAULTS));
    act(() =>
      result.current[4]((p) => {
        for (const key of ["urgent", "dateFrom", "sort", "dir"]) p.delete(key);
      }),
    );
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0][0]).toBe("/orders?status=DRAFT");
  });

  it("a change that changes nothing does not navigate", () => {
    currentQuery = "status=DRAFT&page=2";
    const { result } = renderHook(() => useUrlFilters(DEFAULTS));
    act(() => result.current[4]((p) => p.delete("sort"), { keepPage: true }));
    act(() => result.current[4]((p) => p.delete("sort")));
    expect(replace).not.toHaveBeenCalled();
  });
});
