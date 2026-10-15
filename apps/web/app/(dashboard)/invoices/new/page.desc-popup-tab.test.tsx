import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import NewInvoicePage from "./page";

/**
 * Row 446: the line's description popup ("Create new product: ...") stayed open after Tab moved focus
 * on, covering the unit select below. It now closes when focus leaves the field for anything but its
 * own list; clicking a row in the list still works.
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

const PRODUCT = { id: "p-soda", name: "Soda", unit: "each", pricePerUnit: "4.00" };

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

describe("new invoice - the description popup closes on Tab (row 446)", () => {
  it("Tab away from the description closes the Create new product popup", async () => {
    const user = await openBuilder();
    await user.type(rowInput(), "zz new thing");
    expect(await screen.findByText(/Create new product/)).toBeInTheDocument();
    await user.tab();
    await waitFor(() => expect(screen.queryByText(/Create new product/)).not.toBeInTheDocument());
    expect(rowInput()).not.toHaveFocus();
  });

  it("a click on a product in the popup still picks it (the list keeps focus)", async () => {
    mockSearchProducts = [PRODUCT];
    const user = await openBuilder();
    await user.type(rowInput(), "soda");
    await user.click(await screen.findByRole("button", { name: /Soda/ }));
    await waitFor(() => expect((rowInput() as HTMLInputElement).value).toBe("Soda"));
  });
});
