import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent, within } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { CounterSaleScreen } from "./CounterSaleScreen";

/** B1373: a till line shows its quantity in the order row's number field (no "× N" text). */
const qtyOf = (line: HTMLElement) =>
  Number(
    (within(line).getByRole("spinbutton", { name: /Set quantity of/ }) as HTMLInputElement).value,
  );

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
const HOUSEHOLD = Array.from({ length: 12 }, (_, i) =>
  row(`h-${i + 1}`, `Household item ${String(i + 1).padStart(2, "0")}`, `HH-${i + 1}`),
);
// B1373: a family (a header, never a line) with two sellable variants, as GET /products?includeVariants answers it.
const COLA = {
  id: "fam-1",
  name: "Cola",
  sku: null,
  kind: "FAMILY",
  pricePerUnit: 0,
  unit: "each",
  isActive: true,
  variants: [
    {
      ...row("v-1", "Cherry", "CO-1"),
      kind: "VARIANT",
      parentProductId: "fam-1",
      variantName: "Cherry",
    },
    {
      ...row("v-2", "Vanilla", "CO-2"),
      kind: "VARIANT",
      parentProductId: "fam-1",
      variantName: "Vanilla",
    },
  ],
};
// B1373 review M1: a family whose variants are all inactive comes back with none; it is never offered, never a line.
const EMPTY_FAMILY = { ...COLA, id: "fam-2", name: "Seasonal pack", variants: [] };
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
      if (params.search || params.scanCode) searchCalls.push(params);
      if (params.search) {
        if (String(params.search).toLowerCase().startsWith("seas"))
          return { data: { data: [EMPTY_FAMILY], meta: { total: 1, page: 1, limit: 20 } } };
        if (String(params.search).toLowerCase().startsWith("col"))
          return { data: { data: [COLA], meta: { total: 1, page: 1, limit: 20 } } };
        const hit = [...CHOC, ...HOUSEHOLD].filter((p) =>
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
    expect(qtyOf(lines()[0])).toBe(3);
  });

  it("shows at most 10 matches", async () => {
    renderWithProviders(<CounterSaleScreen />);
    type("household");
    const list = await screen.findByRole("listbox", { name: "Matching items" });
    expect(within(list).getAllByRole("option")).toHaveLength(10);
  });

  it("a scan-code-shaped term searches by scanCode", async () => {
    renderWithProviders(<CounterSaleScreen />);
    type("012345678905");
    await waitFor(() => expect(searchCalls).toHaveLength(1));
    expect(searchCalls[0]).toMatchObject({ scanCode: "012345678905" });
    expect(searchCalls[0].search).toBeUndefined();
  });
});

describe("B1373: the counter lists products the way Create Order does (one ProductSearchList)", () => {
  it("the list starts at the first letter", async () => {
    renderWithProviders(<CounterSaleScreen />);
    type("c");
    const list = await screen.findByRole("listbox", { name: "Matching items" });
    expect(within(list).getAllByRole("option").length).toBeGreaterThan(0);
    expect(searchCalls.map((c) => c.search)).toEqual(["c"]);
  });

  it("every row names its unit and its price, as the order list does", async () => {
    renderWithProviders(<CounterSaleScreen />);
    type("choc");
    const list = await screen.findByRole("listbox", { name: "Matching items" });
    const bar = within(list).getByRole("option", { name: /Chocolate bar/ });
    expect(bar).toHaveTextContent("CH-1");
    expect(bar).toHaveTextContent("each");
    expect(bar).toHaveTextContent("$3.00");
  });

  it("a family is a header with its variant count; it opens on a click and a variant adds as <Family> - <Variant>", async () => {
    renderWithProviders(<CounterSaleScreen />);
    type("cola");
    const list = await screen.findByRole("listbox", { name: "Matching items" });
    const header = within(list).getByRole("option", { name: /Cola/ });
    expect(header).toHaveTextContent("2 variants");
    expect(within(list).queryByRole("option", { name: /Cherry/ })).toBeNull();
    fireEvent.click(header);
    expect(lines()).toHaveLength(0); // a family is never a line
    fireEvent.click(await within(list).findByRole("option", { name: /Cherry/ }));
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("Cola - Cherry");
  });

  it("a family with no live variants is never offered and never added as a line", async () => {
    renderWithProviders(<CounterSaleScreen />);
    type("seasonal");
    const list = await screen.findByRole("listbox", { name: "Matching items" });
    await within(list).findByText("No products found.");
    expect(within(list).queryByRole("option", { name: /Seasonal pack/ })).toBeNull();
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    fireEvent.keyDown(field(), { key: "Enter" });
    await new Promise((r) => setTimeout(r, 50));
    expect(lines()).toHaveLength(0);
  });

  it("the keyboard opens a family too: Enter on the header opens it, Enter on a variant adds it", async () => {
    renderWithProviders(<CounterSaleScreen />);
    type("cola");
    await screen.findByRole("listbox", { name: "Matching items" });
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    fireEvent.keyDown(field(), { key: "Enter" });
    await screen.findByRole("option", { name: /Vanilla/ });
    expect(lines()).toHaveLength(0);
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("Cola - Vanilla");
  });

  it("a product already in the cart shows dimmed in the list", async () => {
    renderWithProviders(<CounterSaleScreen />);
    type("choc");
    let list = await screen.findByRole("listbox", { name: "Matching items" });
    fireEvent.click(within(list).getByRole("option", { name: /Chocolate milk/ }));
    await waitFor(() => expect(lines()).toHaveLength(1));
    type("choc");
    list = await screen.findByRole("listbox", { name: "Matching items" });
    expect(within(list).getByRole("option", { name: /Chocolate milk/ })).toHaveClass("opacity-40");
    expect(within(list).getByRole("option", { name: /Chocolate bar/ })).not.toHaveClass(
      "opacity-40",
    );
  });
});
