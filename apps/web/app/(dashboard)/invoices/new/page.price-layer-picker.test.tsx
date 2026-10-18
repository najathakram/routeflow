import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import NewInvoicePage from "./page";

/**
 * S19b integration review SHOULD 1: the invoices/new unit picker gets the customer's layer, so its dropdown shows the layer's
 * unit price and a Case line is never re-priced by the picker's first-sight refresh (which would wipe packDisplay, pricing,
 * regularPrice and isSpecialPrice on switching back to Box). Harness: page.price-layer-units.test.tsx.
 */
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", role: "OPERATOR" } }),
}));
let mockCustomers: Array<Record<string, unknown>> = [];
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: mockCustomers } }),
  useCustomerPrices: () => ({ data: [] }),
}));
let mockBarcodeProduct: Record<string, unknown> | undefined;
jest.mock("@/lib/api/units-v2", () => ({ usePricesV2Enabled: () => true }));
const LADDER = [
  {
    id: "u-case",
    productId: "p-24",
    label: "Case",
    factorToBase: 12,
    price: "24.00",
    priceTier2: null,
    priceTier3: "22.00",
    priceTier4: null,
    priceTier5: null,
    isDefaultSelling: false,
    sortOrder: 0,
  },
];
const LAYER = {
  customerId: "cust-1",
  complete: true,
  products: {
    "p-24": [
      { ref: "pack", label: null, price: 40, listPrice: 48, source: "customer", aboveList: false },
      {
        ref: "u-case",
        label: "Case",
        price: 21,
        listPrice: 24,
        source: "customer-shape",
        aboveList: false,
      },
    ],
  },
};
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn(async (url: string) => {
      if (url === "/customers/cust-1/price-layer") return { data: LAYER };
      if (url === "/billing/subscription") return { data: { flags: ["flag.units_v1"] } };
      if (/^\/products\/[^/]+\/units$/.test(url)) return { data: LADDER };
      if (url.startsWith("/products/barcode/")) return { data: mockBarcodeProduct };
      return { data: {} };
    }),
    post: jest.fn().mockResolvedValue({ data: {} }),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [] } }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  useCreateInvoice: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
  useUpdateInvoice: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
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
jest.mock("@/lib/api/tracked-categories", () => ({ useTrackedCategories: () => ({ data: [] }) }));
jest.mock("@/components/BarcodeScannerButton", () => ({ BarcodeScannerButton: () => null }));
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: () => null,
}));
jest.mock("@/lib/fetch-pdf-blob", () => ({
  fetchPdfBlob: jest.fn().mockResolvedValue(new Blob()),
}));

const BOXED = {
  id: "p-24",
  name: "Soda",
  unit: "Box",
  pricePerUnit: "48",
  priceTier3: "44",
  unitsPerBox: 24,
  scanMatch: { levels: ["BOX", "UNIT"] },
};

async function openWithSoda() {
  mockCustomers = [{ id: "cust-1", businessName: "Acme Co", pricingTier: 3 }];
  const user = userEvent.setup();
  renderWithProviders(<NewInvoicePage />);
  await user.click(
    screen.getByRole("button", { name: /other charge \(a fee or correction with no order\)/i }),
  );
  await user.click(screen.getByPlaceholderText(/search customers/i));
  await user.click(await screen.findByText("Acme Co"));
  await waitFor(() =>
    expect(screen.queryByText(/checking this customer/i)).not.toBeInTheDocument(),
  );
  mockBarcodeProduct = BOXED;
  const input = screen.getByPlaceholderText(/scan barcode, or type product name/i);
  await user.click(input);
  await user.type(input, "CODE{Enter}");
  await screen.findByDisplayValue("Soda");
  return user;
}

beforeEach(() => {
  Element.prototype.scrollIntoView = jest.fn();
});

describe("invoices/new unit picker is fed the customer's layer", () => {
  it("the dropdown lists the Case at the layer's $21.00 (not the tier's $22.00) and the Box at the layer's $40.00", async () => {
    await openWithSoda();
    const picker = await screen.findByRole("combobox", { name: "Sell Soda by" });
    const text = Array.from((picker as HTMLSelectElement).options).map((o) => o.textContent ?? "");
    expect(text.some((t) => /Case/.test(t) && t.includes("$21.00"))).toBe(true);
    expect(text.some((t) => t.includes("$22.00"))).toBe(false);
    expect(text.some((t) => /Box/.test(t) && t.includes("$40.00"))).toBe(true);
  });

  it("Case and back to Box: the pack's own display (price, regular price, special marker) is restored, not wiped", async () => {
    const user = await openWithSoda();
    const picker = await screen.findByRole("combobox", { name: "Sell Soda by" });
    await user.selectOptions(picker, "Case");
    await waitFor(() =>
      expect(parseFloat((screen.getByLabelText("Unit price") as HTMLInputElement).value)).toBe(21),
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "Sell Soda by" }), "");
    await waitFor(() =>
      expect(parseFloat((screen.getByLabelText("Unit price") as HTMLInputElement).value)).toBe(40),
    );
    // the pack's strikethrough list price ($48) is still shown: the pack line was not wiped on the way back
    expect(screen.getAllByText(/48\.00/).length).toBeGreaterThan(0);
  });
});
