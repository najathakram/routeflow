import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import NewInvoicePage from "./page";

/**
 * B1215 C6/C7 on the new-invoice screen: a flavor-only search hit re-attaches its parent (opened)
 * so the variant is selectable, the line is named "<Parent> - <Variant>", and a FAMILY is never
 * added as a line (neither from the row picker nor the scan bar's typeahead).
 */

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [{ id: "cust-1", businessName: "Acme Co" }] } }),
  useCustomerPrices: () => ({ data: [] }),
}));

let mockSearchProducts: Array<Record<string, unknown>> = [];
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
    get: jest.fn().mockResolvedValue({ data: {} }),
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

const VARIANT = {
  id: "v-straw",
  name: "Strawberry",
  variantName: "Strawberry",
  kind: "VARIANT",
  parentProductId: "f-pod",
  parent: { id: "f-pod", name: "Sample Pod" },
  unit: "each",
  pricePerUnit: "4.00",
};
const FAMILY = {
  id: "f-pod",
  name: "Sample Pod",
  kind: "FAMILY",
  parentProductId: null,
  pricePerUnit: "0",
  variants: [
    {
      id: "v-mint",
      name: "Mint",
      variantName: "Mint",
      kind: "VARIANT",
      parentProductId: "f-pod",
      unit: "each",
      pricePerUnit: "4.00",
    },
  ],
};

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

const rowInput = () => screen.getAllByPlaceholderText("Description / product…")[0];

beforeEach(() => {
  Element.prototype.scrollIntoView = jest.fn();
  mockSearchProducts = [];
});

describe("new invoice - product search variants and families (B1215)", () => {
  it("C6: a flavor-only hit shows the parent opened and the variant selectable", async () => {
    mockSearchProducts = [VARIANT];
    const user = await openBuilder();
    await user.type(rowInput(), "strawberry");
    expect(await screen.findByText("Sample Pod")).toBeInTheDocument();
    expect(screen.queryByText("No products found.")).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /Sample Pod - Strawberry/ }));
    await waitFor(() =>
      expect((rowInput() as HTMLInputElement).value).toBe("Sample Pod - Strawberry"),
    );
  });

  it("C7: a FAMILY header only opens; it is never put on the line", async () => {
    mockSearchProducts = [FAMILY];
    const user = await openBuilder();
    await user.type(rowInput(), "pod");
    await user.click(await screen.findByRole("button", { name: /Sample Pod/ }));
    expect(await screen.findByRole("button", { name: /Sample Pod - Mint/ })).toBeInTheDocument();
    expect((rowInput() as HTMLInputElement).value).toBe("pod");
  });

  it("C7: the scan bar typeahead offers a family's variants, never the family", async () => {
    mockSearchProducts = [FAMILY];
    const user = await openBuilder();
    const bar = screen.getByPlaceholderText(/scan barcode, or type product name/i);
    await user.type(bar, "pod");
    expect(await screen.findByText("Sample Pod - Mint")).toBeInTheDocument();
    expect(screen.queryByText("Sample Pod")).not.toBeInTheDocument();
  });
});
