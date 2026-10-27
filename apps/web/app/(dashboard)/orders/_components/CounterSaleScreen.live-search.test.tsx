import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent, within } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * W-852: typing in "Scan or type an item" shows a live list of matching items as the operator types (the same
 * debounced product search Create Order uses), not only after Enter. A click adds the item; Enter keeps its exact
 * scan behaviour.
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
const ALL = Array.from({ length: 12 }, (_, i) => product(i + 1));
const searchCalls: Array<Record<string, unknown>> = [];

beforeEach(() => {
  jest.clearAllMocks();
  searchCalls.length = 0;
  window.localStorage.clear();
  window.sessionStorage.clear();
  (apiClient.get as jest.Mock).mockImplementation(async (url: string, cfg?: any) => {
    if (url === "/settings") return { data: { taxRate: 0 } };
    if (url === "/products/categories") return { data: ["Snacks", "Household"] };
    if (url.startsWith("/products/barcode/")) return Promise.reject({ response: { status: 404 } });
    if (url === "/products") {
      const params = cfg?.params ?? {};
      if (params.search || params.scanCode) searchCalls.push(params);
      const term = String(params.search ?? "").toLowerCase();
      const rows = term ? ALL.filter((p) => p.name.toLowerCase().includes(term)) : [];
      return { data: { data: rows, meta: { total: rows.length } } };
    }
    throw new Error(`unexpected GET ${url}`);
  });
});

const field = () => screen.getByLabelText("Scan or search items") as HTMLInputElement;
const lines = () =>
  within(screen.getByRole("list", { name: "Items" }))
    .queryAllByRole("listitem")
    .filter((li) => li.textContent !== "No items yet.");

describe("counter live item search (W-852)", () => {
  it("lists matching items while typing, before Enter, and a click adds the line", async () => {
    renderWithProviders(<CounterSaleScreen />);
    fireEvent.change(field(), { target: { value: "item 0" } });
    const list = await screen.findByRole("listbox", { name: "Matching items" });
    expect(within(list).getAllByRole("option")).toHaveLength(9);
    expect(within(list).getByRole("option", { name: /Household item 01/ })).toBeInTheDocument();
    expect(lines()).toHaveLength(0);
    expect(searchCalls[0]).toMatchObject({
      search: "item 0",
      isActive: true,
      includeVariants: true,
    });

    fireEvent.click(within(list).getByRole("option", { name: /Household item 03/ }));
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("Household item 03");
    expect(field().value).toBe("");
    expect(screen.queryByRole("listbox", { name: "Matching items" })).toBeNull();
  });

  it("shows at most 10 matches", async () => {
    renderWithProviders(<CounterSaleScreen />);
    fireEvent.change(field(), { target: { value: "household" } });
    const list = await screen.findByRole("listbox", { name: "Matching items" });
    expect(within(list).getAllByRole("option")).toHaveLength(10);
  });

  it("a typed quantity carries to the clicked match", async () => {
    renderWithProviders(<CounterSaleScreen />);
    fireEvent.change(field(), { target: { value: "3" } });
    fireEvent.submit(field().closest("form")!);
    await waitFor(() => expect(field().value).toBe(""));
    fireEvent.change(field(), { target: { value: "item 05" } });
    const list = await screen.findByRole("listbox", { name: "Matching items" });
    fireEvent.click(within(list).getByRole("option", { name: /Household item 05/ }));
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("Household item 05");
    expect(lines()[0]).toHaveTextContent("3");
  });

  it("a scan-code-shaped term searches by scanCode and a bare quantity never searches", async () => {
    renderWithProviders(<CounterSaleScreen />);
    fireEvent.change(field(), { target: { value: "12" } });
    await new Promise((r) => setTimeout(r, 450));
    expect(searchCalls).toHaveLength(0);
    fireEvent.change(field(), { target: { value: "012345678905" } });
    await waitFor(() => expect(searchCalls).toHaveLength(1));
    expect(searchCalls[0]).toMatchObject({ scanCode: "012345678905" });
    expect(searchCalls[0].search).toBeUndefined();
  });
});
