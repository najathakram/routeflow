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
