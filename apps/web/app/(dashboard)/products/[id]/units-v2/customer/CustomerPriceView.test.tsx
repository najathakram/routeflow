import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CustomerUnitPricesResponse } from "@routeflow/types";
import { CustomerPriceView, resetCustomerViewMemory } from "./CustomerPriceView";
import { CUSTOMER_VIEW_TESTIDS as T } from "./customer-testids";

// K6 (V10, V11): the Customer view. The server resolves every price; the view only shows it.
const mockPrices = jest.fn();
const mockCustomers = jest.fn();
jest.mock("@/lib/api/useCustomerUnitPrices", () => ({
  useCustomerUnitPrices: (...a: unknown[]) => mockPrices(...a),
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: (...a: unknown[]) => mockCustomers(...a),
}));
jest.mock("@/lib/api/tier-labels", () => ({
  useTierLabels: () => ({ data: { "1": "Retail", "2": "Wholesale" } }),
}));

const response = (over: Partial<CustomerUnitPricesResponse> = {}): CustomerUnitPricesResponse => ({
  customerId: "c1",
  customerName: "Corner Market",
  tier: 2,
  total: 1,
  page: 1,
  limit: 10,
  products: [
    {
      productId: "p1",
      productName: "Cola",
      tier: 2,
      orderUnit: null,
      orderUnitLabel: "Case",
      revision: 1,
      rows: [
        {
          ref: "pack",
          label: "Case",
          factor: 24,
          kind: "pack",
          code: "SKU-1",
          price: 20,
          listPrice: 24,
          tierPrice: 21,
          source: "customer",
        },
        {
          ref: "base",
          label: "Piece",
          factor: 1,
          kind: "base",
          code: null,
          price: 0.83,
          listPrice: 1,
          tierPrice: 0.88,
          source: "customer-shape",
        },
        {
          ref: "u1",
          label: "Box",
          factor: 6,
          kind: "unit",
          code: null,
          price: 5.25,
          listPrice: 6,
          tierPrice: 5.25,
          source: "tier",
        },
      ],
    },
  ],
  ...over,
});

const loaded = (data: CustomerUnitPricesResponse) => ({ data, isLoading: false, isError: false });

beforeEach(() => {
  resetCustomerViewMemory();
  mockPrices.mockReset();
  mockCustomers.mockReset();
  mockCustomers.mockReturnValue({
    data: { data: [{ id: "c1", businessName: "Corner Market", contactName: "Sam" }] },
  });
  mockPrices.mockImplementation((id: string | null) =>
    id ? loaded(response()) : { data: undefined, isLoading: false, isError: false },
  );
});

describe("CustomerPriceView on the product page (V10: start on no one, find any customer)", () => {
  it("starts on no one with the empty state and fetches nothing", () => {
    render(<CustomerPriceView productId="p1" />);
    expect(screen.getByTestId(T.empty)).toHaveTextContent(
      "Choose a customer to see their units and prices.",
    );
    expect(screen.queryByTestId(T.body)).toBeNull();
    expect(mockPrices).toHaveBeenCalledWith(null, "p1", expect.anything());
  });

  it("finds any customer by name, then shows that customer's prices for the product", async () => {
    render(<CustomerPriceView productId="p1" />);
    fireEvent.change(screen.getByTestId(T.search), { target: { value: "corner" } });
    await waitFor(() =>
      expect(mockCustomers).toHaveBeenCalledWith(expect.objectContaining({ search: "corner" })),
    );
    fireEvent.click(await screen.findByTestId(T.result("c1")));
    expect(mockPrices).toHaveBeenLastCalledWith("c1", "p1", expect.anything());
    expect(screen.getByTestId(T.chosen)).toHaveTextContent("Corner Market");
    expect(screen.queryByTestId(T.empty)).toBeNull();
    // Product name is not repeated when the view is already one product's page.
    expect(screen.queryByRole("heading", { name: "Cola" })).toBeNull();
    expect(screen.getByTestId(T.row("p1", "pack"))).toHaveTextContent("$20.00");
  });

  it("remembers the last choice for the session and can go back to no one", async () => {
    const { unmount } = render(<CustomerPriceView productId="p1" />);
    fireEvent.click(await screen.findByTestId(T.result("c1")));
    unmount();
    render(<CustomerPriceView productId="p1" />);
    expect(screen.getByTestId(T.chosen)).toHaveTextContent("Corner Market");
    fireEvent.click(screen.getByTestId(T.change));
    expect(screen.getByTestId(T.empty)).toBeInTheDocument();
  });
});

describe("CustomerPriceView on the customer page", () => {
  it("shows the fixed customer's products with no picker, and is read only", () => {
    render(<CustomerPriceView customerId="c1" />);
    expect(mockPrices).toHaveBeenCalledWith("c1", undefined, expect.anything());
    expect(screen.queryByTestId(T.search)).toBeNull();
    expect(screen.getByRole("heading", { name: "Unit prices" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Cola" })).toBeInTheDocument();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryAllByRole("spinbutton")).toHaveLength(0);
  });

  it("says Orders in with the plain wording, and Same as your business setting only when it is", () => {
    const { rerender } = render(<CustomerPriceView customerId="c1" />);
    expect(screen.getByTestId(T.ordersIn("p1"))).toHaveTextContent(
      "Orders in Case. Same as your business setting.",
    );
    mockPrices.mockImplementation(() => {
      const r = response();
      r.products[0] = { ...r.products[0], orderUnit: "base", orderUnitLabel: "Piece" };
      return loaded(r);
    });
    rerender(<CustomerPriceView customerId="c1" />);
    const line = screen.getByTestId(T.ordersIn("p1"));
    expect(line).toHaveTextContent("Orders in Piece.");
    expect(line).not.toHaveTextContent("business setting");
  });

  it("shows one Auto pill with a short caption, never the repeated 'Auto,' text (P06)", () => {
    render(<CustomerPriceView customerId="c1" />);
    expect(document.body.textContent).not.toContain("Auto,");
    const shape = screen.getByTestId(T.row("p1", "base"));
    expect(within(shape).getAllByText("Auto")).toHaveLength(1);
    expect(shape).toHaveTextContent("From their Case price");
    expect(screen.getByTestId(T.row("p1", "u1"))).toHaveTextContent("Wholesale");
    expect(screen.getByTestId(T.row("p1", "pack"))).toHaveTextContent("Set for this customer");
  });

  it("keeps two always-visible columns, Unit then Price, with top-aligned cells (P05, P07)", () => {
    render(<CustomerPriceView customerId="c1" />);
    const table = screen.getByTestId(T.prices("p1"));
    const heads = within(table).getAllByRole("columnheader");
    expect(heads[0]).toHaveTextContent("Unit");
    expect(heads[1]).toHaveTextContent("Price");
    expect(heads[0].className).toContain("align-top");
    // The extra comparison columns are hidden below the sm breakpoint.
    expect(heads[2].className).toContain("hidden");
    expect(heads[2].className).toContain("sm:table-cell");
  });

  it("starts 'Where this comes from' closed", () => {
    render(<CustomerPriceView customerId="c1" />);
    const where = screen.getByTestId(T.where("p1")) as HTMLDetailsElement;
    expect(where.tagName).toBe("DETAILS");
    expect(where.hasAttribute("open")).toBe(false);
    expect(where.open).toBe(false);
  });

  it("explains an empty list in plain words", () => {
    mockPrices.mockImplementation(() => loaded(response({ products: [], total: 0 })));
    render(<CustomerPriceView customerId="c1" />);
    expect(screen.getByText(/has no prices of their own yet/)).toBeInTheDocument();
  });

  it("pages when there are more products than one page", () => {
    mockPrices.mockImplementation((_id: string, _p: unknown, o: { page: number }) =>
      loaded(response({ total: 25, page: o.page, limit: 10 })),
    );
    render(<CustomerPriceView customerId="c1" />);
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
    expect(screen.getByTestId(T.prev)).toBeDisabled();
    fireEvent.click(screen.getByTestId(T.next));
    expect(mockPrices).toHaveBeenLastCalledWith(
      "c1",
      undefined,
      expect.objectContaining({ page: 2 }),
    );
  });

  it("shows an error line, not a blank, when the prices cannot load", () => {
    mockPrices.mockImplementation(() => ({ data: undefined, isLoading: false, isError: true }));
    render(<CustomerPriceView customerId="c1" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load");
  });
});
