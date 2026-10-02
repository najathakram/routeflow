import { renderHook, act } from "@testing-library/react";
import { useInventoryTab } from "./use-inventory-tab";

const replace = jest.fn();
let query = "";
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(query),
}));

beforeEach(() => {
  replace.mockClear();
  query = "";
});

describe("useInventoryTab", () => {
  it("redirects ?tab=purchase-orders to the PO route", () => {
    query = "tab=purchase-orders";
    renderHook(() => useInventoryTab());
    expect(replace).toHaveBeenCalledWith("/purchase-orders");
  });

  it("does not redirect for a normal tab and opens it", () => {
    query = "tab=suppliers";
    const { result } = renderHook(() => useInventoryTab());
    expect(replace).not.toHaveBeenCalled();
    expect(result.current.activeTab).toBe("suppliers");
  });

  it("falls back to stock for an unknown tab", () => {
    query = "tab=bogus";
    const { result } = renderHook(() => useInventoryTab());
    expect(result.current.activeTab).toBe("stock");
  });

  it("selectTab updates state and the URL", () => {
    const { result } = renderHook(() => useInventoryTab());
    act(() => result.current.selectTab("forecasting"));
    expect(result.current.activeTab).toBe("forecasting");
    expect(window.location.search).toBe("?tab=forecasting");
  });
});
