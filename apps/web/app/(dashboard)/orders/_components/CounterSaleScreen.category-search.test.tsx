import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent, within } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * CQ-10: typing a category name in "Scan or type an item" lists that category's products (the same server search
 * the product picker uses, paginated) instead of "No product found for that code."
 */
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [] } }),
  useCustomerPrices: () => ({
    data: [],
    isSuccess: true,
    isError: false,
    isFetching: false,
    refetch: jest.fn(),
  }),
}));
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn(), post: jest.fn() } }));
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({
    showButton: true,
    opensAsCounter: true,
    offerShipInstead: false,
    capability: { counter: "always" },
  }),
  useCreateCounterSale: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useCounterSaleByKey: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

const product = (n: number) => ({
  id: `p-${n}`,
  name: `Household item ${String(n).padStart(2, "0")}`,
  sku: `HH-${n}`,
  pricePerUnit: 2,
  unit: "each",
  unitsPerBox: null,
  isActive: true,
});
const ALL = Array.from({ length: 25 }, (_, i) => product(i + 1));
const categoryCalls: Array<Record<string, unknown>> = [];

beforeEach(() => {
  jest.clearAllMocks();
  categoryCalls.length = 0;
  window.localStorage.clear();
  window.sessionStorage.clear();
  (apiClient.get as jest.Mock).mockImplementation(async (url: string, cfg?: any) => {
    if (url === "/settings") return { data: { taxRate: 0 } };
    if (url === "/products/categories") return { data: ["Snacks", "Household"] };
    if (url.startsWith("/products/barcode/")) return Promise.reject({ response: { status: 404 } });
    if (url === "/products") {
      const params = cfg?.params ?? {};
      if (params.category) {
        categoryCalls.push(params);
        const limit = params.limit ?? 20;
        const page = params.page ?? 1;
        const rows = params.category === "Household" ? ALL : [];
        return {
          data: {
            data: rows.slice((page - 1) * limit, page * limit),
            meta: { total: rows.length, page, limit },
          },
        };
      }
      return { data: { data: [] } };
    }
    throw new Error(`unexpected GET ${url}`);
  });
});

const scan = async (text: string) => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: text } });
  fireEvent.submit(field.closest("form")!);
  await waitFor(() => expect((field as HTMLInputElement).value).toBe(""));
};
const lines = () =>
  within(screen.getByRole("list", { name: "Items" }))
    .queryAllByRole("listitem")
    .filter((li) => li.textContent !== "No items yet.");

describe("counter category search (CQ-10)", () => {
  it("a category name lists that category's products, and a click adds the line", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("household");
    const picker = await screen.findByTestId("counter-scan-picker");
    expect(picker).toHaveTextContent("Household");
    expect(within(picker).getByRole("button", { name: /Household item 01/ })).toBeInTheDocument();
    expect(screen.queryByText(/No product found/)).toBeNull();
    fireEvent.click(within(picker).getByRole("button", { name: /Household item 02/ }));
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("Household item 02");
    expect(categoryCalls[0]).toMatchObject({
      category: "Household",
      isActive: true,
      page: 1,
      limit: 20,
    });
  });

  it("is paginated: the first page is 20 of 25 and 'Show more' appends the rest", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("Household");
    const picker = await screen.findByTestId("counter-scan-picker");
    expect(within(picker).getAllByRole("button", { name: /Household item/ })).toHaveLength(20);
    expect(picker).toHaveTextContent("20 of 25");
    fireEvent.click(within(picker).getByRole("button", { name: "Show more" }));
    await waitFor(() =>
      expect(within(picker).getAllByRole("button", { name: /Household item/ })).toHaveLength(25),
    );
    expect(within(picker).queryByRole("button", { name: "Show more" })).toBeNull();
    expect(categoryCalls.map((c) => c.page)).toEqual([1, 2]);
  });

  it("text that is no code and no category still reads 'No product found for that code.'", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("zzzz");
    await waitFor(() =>
      expect(screen.getByText(/No product found for that code/)).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("counter-scan-picker")).toBeNull();
  });
});
