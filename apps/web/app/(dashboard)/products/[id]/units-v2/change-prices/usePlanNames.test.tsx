import { renderHook } from "@testing-library/react";
import { usePlanNames } from "./usePlanNames";

let mockLabels: Record<string, string> = {};
let mockTruncated: boolean | undefined = false;
jest.mock("../edit/usePriceDraft", () => ({
  usePriceDraft: () => ({ grid: { productId: "p1", tierRules: {} } }),
}));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: mockLabels }) }));
jest.mock("@/lib/api/useProductCustomerPrices", () => ({
  useProductCustomerPrices: () => ({
    data: {
      customers: [{ customerId: "c1", name: "Northside", tier: 1, orderUnit: null, set: {} }],
      truncated: mockTruncated,
    },
  }),
}));

beforeEach(() => {
  mockLabels = {};
  mockTruncated = false;
});

describe("usePlanNames", () => {
  it("names tier 1 Retail until the tenant relabels it, then by the tenant's own label (P02)", () => {
    const { result, rerender } = renderHook(() => usePlanNames());
    expect(result.current.tierName(1)).toBe("Retail");
    mockLabels = { "1": "Standard", "2": "Wholesale" };
    rerender();
    expect(result.current.tierName(1)).toBe("Standard");
    expect(result.current.tierName(2)).toBe("Wholesale");
    expect(result.current.tierName(3)).toBe("Tier 3");
  });

  it("treats a blank tier 1 label as unset", () => {
    mockLabels = { "1": "   " };
    const { result } = renderHook(() => usePlanNames());
    expect(result.current.tierName(1)).toBe("Retail");
  });

  it("K3b NIT-3: passes the server's truncated flag on, false when it is missing", () => {
    const { result, rerender } = renderHook(() => usePlanNames());
    expect(result.current.customersTruncated).toBe(false);
    mockTruncated = true;
    rerender();
    expect(result.current.customersTruncated).toBe(true);
    mockTruncated = undefined;
    rerender();
    expect(result.current.customersTruncated).toBe(false);
  });
});
