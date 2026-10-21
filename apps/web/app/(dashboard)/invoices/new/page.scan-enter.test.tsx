import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import NewInvoicePage from "./page";

/**
 * M3: in the new-invoice scan/search bar, Enter must add the row the operator is LOOKING AT.
 * The dropdown shows the flattened typeahead (families expand to their variants); the old Enter
 * re-fetched the search and took the API's raw first hit, which can be a different product.
 * Enter now takes the highlighted row (first shown by default, ArrowUp/Down moves it), while an
 * exact barcode / SKU code still wins so a wedge scanner keeps working.
 */

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [{ id: "cust-1", businessName: "Acme Co" }] } }),
  useCustomerPrices: () => ({ data: [] }),
}));

const DISTILLED = {
  id: "p-distilled",
  name: "Distilled Water 1 Gallon",
  sku: "DW-1",
  pricePerUnit: "2.00",
  unit: "each",
};
const SPRING_12 = {
  id: "v-spring-12",
  name: "12 Pack",
  variantName: "12 Pack",
  kind: "VARIANT",
  parentProductId: "f-spring",
  unit: "each",
  pricePerUnit: "5.00",
};
const SPRING_24 = { ...SPRING_12, id: "v-spring-24", name: "24 Pack", variantName: "24 Pack" };
const SPRING_FAMILY = {
  id: "f-spring",
  name: "Spring Water",
  kind: "FAMILY",
  parentProductId: null,
  pricePerUnit: "0",
  variants: [SPRING_12, SPRING_24],
};

// What the dropdown is built from (family expands to its variants): Spring 12, Spring 24, Distilled.
let mockSearchProducts: Array<Record<string, unknown>> = [];
// What a SECOND fetch (the old Enter path) returns: the API's raw order, Distilled first.
let mockRawSearch: Array<Record<string, unknown>> = [];
let mockBarcodeProduct: Record<string, unknown> | undefined;
const mockGet = jest.fn((url: string) => {
  if (url.startsWith("/products/barcode/")) {
    return mockBarcodeProduct
      ? Promise.resolve({ data: mockBarcodeProduct })
      : Promise.reject(new Error("not found"));
  }
  if (url === "/products") return Promise.resolve({ data: { data: mockRawSearch } });
  return Promise.resolve({ data: {} });
});
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: mockSearchProducts } }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  useCreateInvoice: () => ({ mutate: jest.fn(), isPending: false }),
  useUpdateInvoice: () => ({ mutate: jest.fn(), isPending: false }),
  useCreateInvoiceFromOrder: () => ({ mutate: jest.fn(), isPending: false }),
  useInvoiceSettings: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/orders", () => ({
  ...jest.requireActual("@/lib/api/orders"),
  useCreateSale: () => ({ mutate: jest.fn(), isPending: false }),
  useUninvoicedOrders: () => ({ orders: [], isLoading: false }),
}));
jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: [] }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (url: string) => mockGet(url),
    post: jest.fn().mockResolvedValue({ data: {} }),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: () => null,
}));
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: () => null,
}));

async function openBuilder() {
  const user = userEvent.setup();
  renderWithProviders(<NewInvoicePage />);
  await user.click(
    screen.getByRole("button", { name: /other charge \(a fee or correction with no order\)/i }),
  );
  await user.click(screen.getByPlaceholderText(/search customers/i));
  await user.click(await screen.findByText("Acme Co"));
  return user;
}

const bar = () => screen.getByPlaceholderText(/scan barcode, or type product name/i);
const lineNames = () =>
  screen
    .getAllByPlaceholderText("Description / product…")
    .map((el) => (el as HTMLInputElement).value)
    .filter(Boolean);

/** The suggestion rows under the scan bar, in the order they are shown. */
const options = () =>
  Array.from(bar().parentElement!.querySelectorAll<HTMLElement>("ul[role=listbox] button"));

async function typeAndWaitForDropdown(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.click(bar());
  await user.type(bar(), text);
  await waitFor(() => expect(options().length).toBeGreaterThan(0));
}

beforeEach(() => {
  jest.clearAllMocks();
  Element.prototype.scrollIntoView = jest.fn();
  mockSearchProducts = [SPRING_FAMILY, DISTILLED];
  mockRawSearch = [DISTILLED, SPRING_FAMILY];
  mockBarcodeProduct = undefined;
});

describe("new invoice scan bar - Enter adds the row that is shown (M3)", () => {
  it("Enter adds the FIRST displayed row, not the API's raw first hit", async () => {
    const user = await openBuilder();
    await typeAndWaitForDropdown(user, "water");
    expect(options()[0]).toHaveTextContent("Spring Water - 12 Pack");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(lineNames()).toEqual(["Spring Water - 12 Pack"]));
  });

  it("ArrowDown then Enter adds the second displayed row", async () => {
    const user = await openBuilder();
    await typeAndWaitForDropdown(user, "water");
    await user.keyboard("{ArrowDown}");
    expect(options()[1]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(lineNames()).toEqual(["Spring Water - 24 Pack"]));
  });

  it("ArrowDown past the end clamps; ArrowUp returns to the first row", async () => {
    const user = await openBuilder();
    await typeAndWaitForDropdown(user, "water");
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(options()[2]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(options()[0]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(lineNames()).toEqual(["Spring Water - 12 Pack"]));
  });

  it("the first shown row is marked as the active descendant before any arrow key", async () => {
    const user = await openBuilder();
    await typeAndWaitForDropdown(user, "water");
    const first = options()[0];
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(bar()).toHaveAttribute("aria-activedescendant", first.id);
  });

  it("an exact barcode still wins over the highlighted row (scanner path)", async () => {
    mockBarcodeProduct = DISTILLED;
    const user = await openBuilder();
    await typeAndWaitForDropdown(user, "8000000000017");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(lineNames()).toEqual(["Distilled Water 1 Gallon"]));
  });

  it("an exact SKU among the shown rows still wins over the first row", async () => {
    const user = await openBuilder();
    await typeAndWaitForDropdown(user, "DW-1");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(lineNames()).toEqual(["Distilled Water 1 Gallon"]));
  });

  it("a scan typed and sent before the dropdown appears keeps the old path", async () => {
    mockBarcodeProduct = DISTILLED;
    const user = await openBuilder();
    await user.click(bar());
    await user.type(bar(), "8000000000017{Enter}");
    await waitFor(() => expect(lineNames()).toEqual(["Distilled Water 1 Gallon"]));
  });

  it("row 671: Enter typed before the dropdown catches up never adds from the pending result - it waits for the list to settle", async () => {
    // The open list was built from an OLDER query ("wat": Distilled only); the API now answers "water"
    // with the family first. That answer is PENDING (not shown yet): Enter must not add it, nor the
    // stale first row. The text stays in the bar so Enter works once the list has settled.
    mockSearchProducts = [DISTILLED];
    mockRawSearch = [SPRING_FAMILY, DISTILLED];
    const user = await openBuilder();
    await typeAndWaitForDropdown(user, "wat");
    expect(options()[0]).toHaveTextContent("Distilled Water 1 Gallon");
    await user.type(bar(), "er{Enter}");
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith("/products"));
    expect(lineNames()).toEqual([]);
    expect(bar()).toHaveValue("water");
  });

  it("row 671: an exact SKU typed before the dropdown catches up is still added (the code names it)", async () => {
    mockSearchProducts = [SPRING_FAMILY];
    mockRawSearch = [SPRING_FAMILY, DISTILLED];
    const user = await openBuilder();
    await typeAndWaitForDropdown(user, "DW-");
    await user.type(bar(), "1{Enter}");
    await waitFor(() => expect(lineNames()).toEqual(["Distilled Water 1 Gallon"]));
  });
});
