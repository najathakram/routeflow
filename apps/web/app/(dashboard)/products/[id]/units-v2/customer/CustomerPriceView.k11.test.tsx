import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { CustomerUnitPricesResponse } from "@routeflow/types";
import { CustomerPriceView, resetCustomerViewMemory } from "./CustomerPriceView";
import { CUSTOMER_VIEW_TESTIDS as T } from "./customer-testids";

// K11-06 (the picked customer survives a refresh through ?customer=) and K11-07 (the table).
const mockPrices = jest.fn();
const mockCustomers = jest.fn();
const mockReplace = jest.fn();
let mockSearch = "";
jest.mock("@/lib/api/useCustomerUnitPrices", () => ({
  useCustomerUnitPrices: (...a: unknown[]) => mockPrices(...a),
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: (...a: unknown[]) => mockCustomers(...a),
}));
let mockLabels: Record<string, string> = { "1": "Retail", "2": "Wholesale" };
jest.mock("@/lib/api/tier-labels", () => ({
  useTierLabels: () => ({ data: mockLabels }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => "/products/p1",
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

type Source = "customer" | "customer-shape" | "history" | "tier";
const response = (
  over: Partial<CustomerUnitPricesResponse> = {},
  tier: 1 | 2 | 3 = 3,
  source: Source = "tier",
): CustomerUnitPricesResponse => ({
  customerId: "c1",
  customerName: "Corner Market",
  tier,
  total: 1,
  page: 1,
  limit: 10,
  products: [
    {
      productId: "p1",
      productName: "Cola",
      tier,
      orderUnit: null,
      orderUnitScope: "default",
      orderUnitLabel: "Case",
      revision: 1,
      rows: [
        {
          ref: "pack",
          label: "Case",
          factor: 24,
          kind: "pack",
          code: null,
          price: 30,
          listPrice: 36,
          tierPrice: 1.4,
          source,
        },
      ],
    },
  ],
  ...over,
});

const loaded = (data: CustomerUnitPricesResponse) => ({ data, isLoading: false, isError: false });
const failed = { data: undefined, isLoading: false, isError: true };
const idle = { data: undefined, isLoading: false, isError: false };

beforeEach(() => {
  resetCustomerViewMemory();
  mockLabels = { "1": "Retail", "2": "Wholesale" };
  mockPrices.mockReset();
  mockCustomers.mockReset();
  mockReplace.mockReset();
  mockSearch = "";
  window.history.replaceState(null, "", "/");
  mockCustomers.mockReturnValue({
    data: { data: [{ id: "c1", businessName: "Corner Market", contactName: "Sam" }] },
  });
  mockPrices.mockImplementation((id: string | null) => (id ? loaded(response()) : idle));
});

describe("K11-06: the picked customer survives a refresh", () => {
  it("picking writes customer=<id> into the URL, keeps the other params and the hash", () => {
    mockSearch = "tab=prices";
    window.history.replaceState(null, "", "/#h-cust");
    render(<CustomerPriceView productId="p1" />);
    act(() => screen.getByTestId(T.search).focus());
    fireEvent.click(screen.getByTestId(T.result("c1")));
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith("/products/p1?tab=prices&customer=c1#h-cust", {
      scroll: false,
    });
  });

  it("the URL carries the id only, never the name", () => {
    render(<CustomerPriceView productId="p1" />);
    act(() => screen.getByTestId(T.search).focus());
    fireEvent.click(screen.getByTestId(T.result("c1")));
    const url = String(mockReplace.mock.calls[0][0]);
    expect(url).toBe("/products/p1?customer=c1");
    expect(url).not.toMatch(/corner|market/i);
  });

  it("mounting with ?customer=x fetches x without a pick, and names them from the response", () => {
    mockSearch = "customer=c1";
    render(<CustomerPriceView productId="p1" />);
    expect(mockPrices).toHaveBeenCalledWith("c1", "p1", expect.anything());
    expect(screen.queryByTestId(T.search)).toBeNull();
    expect(screen.getByTestId(T.chosen)).toHaveTextContent("Corner Market");
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("?customer= wins over the session's last choice", () => {
    render(<CustomerPriceView productId="p1" />);
    act(() => screen.getByTestId(T.search).focus());
    fireEvent.click(screen.getByTestId(T.result("c1")));
    mockPrices.mockClear();
    mockSearch = "customer=c9";
    render(<CustomerPriceView productId="p1" />);
    expect(mockPrices).toHaveBeenCalledWith("c9", "p1", expect.anything());
    expect(mockPrices).not.toHaveBeenCalledWith("c1", "p1", expect.anything());
  });

  it("Choose another customer removes the param and keeps the rest", () => {
    mockSearch = "tab=prices&customer=c1";
    render(<CustomerPriceView productId="p1" />);
    fireEvent.click(screen.getByTestId(T.change));
    expect(mockReplace).toHaveBeenCalledWith("/products/p1?tab=prices", { scroll: false });
    expect(screen.getByTestId(T.empty)).toBeInTheDocument();
  });

  it("an id the server refuses shows the error and the picker, and drops the param", () => {
    mockSearch = "tab=prices&customer=gone";
    mockPrices.mockImplementation((id: string | null) => (id === "gone" ? failed : idle));
    render(<CustomerPriceView productId="p1" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load this customer's prices.");
    expect(screen.getByTestId(T.search)).toBeInTheDocument();
    expect(mockReplace).toHaveBeenCalledWith("/products/p1?tab=prices", { scroll: false });
  });

  it("a refused id is not remembered for the next mount", () => {
    mockSearch = "customer=gone";
    mockPrices.mockImplementation((id: string | null) => (id === "gone" ? failed : idle));
    const { unmount } = render(<CustomerPriceView productId="p1" />);
    unmount();
    mockSearch = "";
    render(<CustomerPriceView productId="p1" />);
    expect(screen.getByTestId(T.search)).toBeInTheDocument();
  });

  it("the customer page (customerId given) never touches the URL", () => {
    mockSearch = "customer=c9";
    render(<CustomerPriceView customerId="c1" />);
    expect(mockPrices).toHaveBeenCalledWith("c1", undefined, expect.anything());
    expect(mockPrices).not.toHaveBeenCalledWith("c9", expect.anything(), expect.anything());
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
