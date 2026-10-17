import * as React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
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

describe("K11-07: nothing repeats in the table, the card fills the column", () => {
  const heads = (id = "p1") =>
    within(screen.getByTestId(T.prices(id)))
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
  const show = (source: Source, tier: 1 | 2 | 3 = 3) => {
    mockPrices.mockImplementation(() => loaded(response({}, tier, source)));
  };

  it("a tier-priced row has Unit, Price and Retail and no tier column", () => {
    show("tier");
    render(<CustomerPriceView customerId="c1" />);
    expect(heads()).toEqual(["Unit", "Price", "Retail"]);
    const row = screen.getByTestId(T.row("p1", "pack"));
    expect(row.querySelectorAll("td")).toHaveLength(3);
    // The tier price is the price: it is not printed a second time in the caption.
    expect(row).not.toHaveTextContent("$1.40");
  });

  it("a customer-set row names the tier price in its caption: no information is lost", () => {
    show("customer");
    render(<CustomerPriceView customerId="c1" />);
    const caption = screen.getByTestId(T.row("p1", "pack")).querySelectorAll("td")[1];
    expect(caption).toHaveTextContent("Set for this customer");
    expect(caption).toHaveTextContent("Tier 3: $1.40");
    expect(heads()).toEqual(["Unit", "Price", "Retail"]);
  });

  it("a row priced from the customer's other unit also names the tier price", () => {
    show("customer-shape");
    render(<CustomerPriceView customerId="c1" />);
    expect(screen.getByTestId(T.row("p1", "pack"))).toHaveTextContent(
      "From their Case price · Tier 3: $1.40",
    );
  });

  it("uses the tenant's label for the tier", () => {
    mockLabels = { "1": "Retail", "3": "Wholesale plus" };
    show("customer");
    render(<CustomerPriceView customerId="c1" />);
    expect(screen.getByTestId(T.row("p1", "pack"))).toHaveTextContent("Wholesale plus: $1.40");
  });

  it("a retail-tier customer's set price adds nothing: the list column already shows it", () => {
    show("customer", 1);
    render(<CustomerPriceView customerId="c1" />);
    expect(screen.getByTestId(T.row("p1", "pack"))).not.toHaveTextContent("$1.40");
  });

  it("the tier fragment hides below sm so a phone still shows the price only", () => {
    show("customer");
    render(<CustomerPriceView customerId="c1" />);
    const fragment = screen.getByText(/Tier 3:/);
    expect(fragment.className).toContain("hidden");
    expect(fragment.className).toContain("sm:inline");
  });

  it("one product on the product page: a single column, the card is not shrink-wrapped", () => {
    render(<CustomerPriceView productId="p1" customerId="c1" />);
    const card = screen.getByTestId(T.product("p1"));
    expect(card.parentElement?.className).not.toContain("lg:grid-cols-2");
    expect(card.className).not.toContain("self-start");
  });

  it("the customer page keeps two columns for many products", () => {
    render(<CustomerPriceView customerId="c1" />);
    const card = screen.getByTestId(T.product("p1"));
    expect(card.parentElement?.className).toContain("lg:grid-cols-2");
  });

  it("every money figure is tabular; the price is medium and the references are regular", () => {
    show("customer");
    render(<CustomerPriceView customerId="c1" />);
    const cells = screen.getByTestId(T.row("p1", "pack")).querySelectorAll("td");
    const price = within(cells[1] as HTMLElement).getByText("$30.00");
    expect(price.className).toContain("tabular-nums");
    expect(price.className).toContain("font-medium");
    expect(cells[2].className).toContain("tabular-nums");
    expect(cells[2].className).toContain("font-normal");
    const tierFigure = within(cells[1] as HTMLElement).getByText("$1.40");
    expect(tierFigure.className).toContain("tabular-nums");
    expect(tierFigure.className).toContain("font-normal");
  });
});
