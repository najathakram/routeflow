import { renderHook, waitFor } from "@testing-library/react";
import { PLAN_KEYS } from "@routeflow/types";
import { selectablePlanKeys, usePlanOptions, withCurrentPlan } from "./usePlanOptions";

const mockFetchPlanCatalog = jest.fn();
jest.mock("@/lib/api/platform-pricing", () => ({
  fetchPlanCatalog: () => mockFetchPlanCatalog(),
}));

function entry(planKey: string, sortOrder: number) {
  return {
    planKey,
    name: planKey,
    monthlyPrice: "0",
    annualPrice: null,
    isCustom: false,
    sortOrder,
  };
}

beforeEach(() => jest.clearAllMocks());

describe("selectablePlanKeys", () => {
  it("keeps only PLAN_KEYS members, ordered by sortOrder", () => {
    expect(
      selectablePlanKeys([
        entry("SCALE", 2),
        entry("TEAM", 0),
        entry("STARTER", 0),
        entry("GROWTH", 1),
      ]),
    ).toEqual(["STARTER", "GROWTH", "SCALE"]);
  });

  it("returns an empty list for a missing catalog", () => {
    expect(selectablePlanKeys(undefined)).toEqual([]);
  });
});

describe("withCurrentPlan", () => {
  it("appends a current plan the list does not offer", () => {
    expect(withCurrentPlan(["STARTER", "GROWTH"], "LITE")).toEqual(["STARTER", "GROWTH", "LITE"]);
  });

  it("leaves the list alone when the current plan is offered or unknown", () => {
    expect(withCurrentPlan(["STARTER", "GROWTH"], "GROWTH")).toEqual(["STARTER", "GROWTH"]);
    expect(withCurrentPlan(["STARTER"], null)).toEqual(["STARTER"]);
  });
});

describe("usePlanOptions", () => {
  it("offers the catalog's eligible plans", async () => {
    mockFetchPlanCatalog.mockResolvedValue({
      version: 11,
      effectiveAt: null,
      plans: [entry("GROWTH", 1), entry("STARTER", 0)],
    });
    const { result } = renderHook(() => usePlanOptions());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toEqual({
      planKeys: ["STARTER", "GROWTH"],
      loading: false,
      unavailable: false,
    });
  });

  it("falls back to PLAN_KEYS when the catalog cannot be read", async () => {
    mockFetchPlanCatalog.mockRejectedValue(new Error("down"));
    const { result } = renderHook(() => usePlanOptions());
    await waitFor(() => expect(result.current.unavailable).toBe(true));
    expect(result.current.planKeys).toEqual([...PLAN_KEYS]);
  });

  it("falls back to PLAN_KEYS when no catalog row is eligible", async () => {
    mockFetchPlanCatalog.mockResolvedValue({
      version: 1,
      effectiveAt: null,
      plans: [entry("TEAM", 0)],
    });
    const { result } = renderHook(() => usePlanOptions());
    await waitFor(() => expect(result.current.unavailable).toBe(true));
    expect(result.current.planKeys).toEqual([...PLAN_KEYS]);
  });
});
