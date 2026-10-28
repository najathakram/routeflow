import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent, within } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * W-852: typing in "Scan or search items" lists the matching products as you type (no Enter), like Create Order's
 * product search: debounced, ArrowUp/Down to highlight, Enter adds the HIGHLIGHTED row, a click adds it. Enter with
 * nothing highlighted is still the scan path, so a wedge scanner is unchanged.
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

const row = (id: string, name: string, sku: string) => ({
  id,
  name,
  sku,
  pricePerUnit: 3,
  unit: "each",
  unitsPerBox: null,
  isActive: true,
});
const CHOC = [
  row("p-1", "Chocolate bar", "CH-1"),
  row("p-2", "Chocolate milk", "CH-2"),
  row("p-3", "Chocolate chip cookies", "CH-3"),
];
const searchCalls: Array<Record<string, unknown>> = [];

beforeEach(() => {
  jest.clearAllMocks();
  searchCalls.length = 0;
  window.localStorage.clear();
  window.sessionStorage.clear();
  (apiClient.get as jest.Mock).mockImplementation(async (url: string, cfg?: any) => {
    if (url === "/settings") return { data: { taxRate: 0 } };
    if (url === "/products/categories") return { data: [] };
    if (url.startsWith("/products/barcode/")) return Promise.reject({ response: { status: 404 } });
    if (url === "/products") {
      const params = cfg?.params ?? {};
      if (params.search) {
        searchCalls.push(params);
        const hit = CHOC.filter((p) =>
          p.name.toLowerCase().includes(String(params.search).toLowerCase()),
        );
        return { data: { data: hit, meta: { total: hit.length, page: 1, limit: 20 } } };
      }
      return { data: { data: [] } };
    }
    throw new Error(`unexpected GET ${url}`);
  });
});

const field = () => screen.getByLabelText("Scan or search items") as HTMLInputElement;
const type = (text: string) => fireEvent.change(field(), { target: { value: text } });
const lines = () =>
  within(screen.getByRole("list", { name: "Items" }))
    .queryAllByRole("listitem")
    .filter((li) => li.textContent !== "No items yet.");

describe("counter live search (W-852)", () => {
  it("typing without Enter lists the matching products", async () => {
    renderWithProviders(<CounterSaleScreen />);
    type("choc");
    const list = await screen.findByRole("listbox", { name: "Matching items" });
    const options = within(list).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("Chocolate bar"),
      expect.stringContaining("Chocolate milk"),
      expect.stringContaining("Chocolate chip cookies"),
    ]);
    expect(lines()).toHaveLength(0); // listing is not adding
    expect(field().value).toBe("choc");
  });

  it("is debounced: a burst of keystrokes sends ONE search for the final text", async () => {
    renderWithProviders(<CounterSaleScreen />);
    for (const t of ["ch", "cho", "choc"]) type(t);
    await screen.findByRole("listbox", { name: "Matching items" });
    expect(searchCalls.map((c) => c.search)).toEqual(["choc"]);
  });

  it("a click on a row adds that line and clears the field", async () => {
    renderWithProviders(<CounterSaleScreen />);
    type("choc");
    const list = await screen.findByRole("listbox", { name: "Matching items" });
    fireEvent.click(within(list).getByRole("option", { name: /Chocolate milk/ }));
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("Chocolate milk");
    expect(field().value).toBe("");
    expect(screen.queryByRole("listbox", { name: "Matching items" })).toBeNull();
  });

  it("Enter adds the HIGHLIGHTED row, not the first one", async () => {
    renderWithProviders(<CounterSaleScreen />);
    type("choc");
    await screen.findByRole("listbox", { name: "Matching items" });
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /Chocolate milk/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("Chocolate milk");
    expect(lines()[0]).not.toHaveTextContent("Chocolate bar");
  });

  it("Enter with nothing highlighted is still the scan: it never takes a row from the list", async () => {
    renderWithProviders(<CounterSaleScreen />);
    type("choc");
    await screen.findByRole("listbox", { name: "Matching items" });
    fireEvent.submit(field().closest("form")!);
    await waitFor(() => expect(field().value).toBe(""));
    expect(
      (apiClient.get as jest.Mock).mock.calls.some(([u]) =>
        String(u).startsWith("/products/barcode/"),
      ),
    ).toBe(true);
    expect(lines().some((l) => /Chocolate bar/.test(l.textContent ?? ""))).toBe(false);
  });

  it("a typed quantity is not a search, and the list closes on Escape", async () => {
    renderWithProviders(<CounterSaleScreen />);
    type("12");
    await new Promise((r) => setTimeout(r, 450));
    expect(searchCalls).toHaveLength(0);
    expect(screen.queryByRole("listbox", { name: "Matching items" })).toBeNull();
    type("choc");
    await screen.findByRole("listbox", { name: "Matching items" });
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Matching items" })).toBeNull();
  });

  it("a typed quantity multiplies the row that is picked", async () => {
    renderWithProviders(<CounterSaleScreen />);
    fireEvent.submit((type("3"), field().closest("form")!)); // the quantity for the next item
    await waitFor(() => expect(field().value).toBe(""));
    type("choc");
    const list = await screen.findByRole("listbox", { name: "Matching items" });
    fireEvent.click(within(list).getByRole("option", { name: /Chocolate bar/ }));
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("Chocolate bar");
    expect(lines()[0]).toHaveTextContent("× 3");
  });
});
