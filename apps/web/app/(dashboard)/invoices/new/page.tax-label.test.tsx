import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import NewInvoicePage from "./page";

/** Row 300: the Tax row names the configured rate (8.25%), never a toFixed(0) round (8%). */
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [{ id: "cust-1", businessName: "Acme Co" }] } }),
  useCustomerPrices: () => ({ data: [] }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({
    data: { data: [{ id: "prod-4", name: "Dropdown Widget", pricePerUnit: "8" }] },
  }),
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
jest.mock("@/lib/api/tracked-categories", () => ({ useTrackedCategories: () => ({ data: [] }) }));

let mockSettings: Record<string, unknown> = {};
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (url: string) => Promise.resolve({ data: url === "/settings" ? mockSettings : {} }),
    post: jest.fn().mockResolvedValue({ data: {} }),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));
jest.mock("@/components/BarcodeScannerButton", () => ({ BarcodeScannerButton: () => null }));
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: () => null,
}));

async function withTaxableLine() {
  const user = userEvent.setup();
  renderWithProviders(<NewInvoicePage />);
  await user.click(
    screen.getByRole("button", { name: /other charge \(a fee or correction with no order\)/i }),
  );
  await user.click(screen.getByPlaceholderText(/search customers/i));
  await user.click(await screen.findByText("Acme Co"));
  const input = screen.getByPlaceholderText("Description / product…");
  await user.click(input);
  await user.type(input, "Dropdown");
  await user.click(await screen.findByText("Dropdown Widget"));
  await user.click(screen.getAllByRole("checkbox")[0]);
}

describe("new invoice: Tax row label (row 300)", () => {
  it("prints the configured 8.25% rate in the totals bar and the summary", async () => {
    mockSettings = { taxRate: 8.25 };
    await withTaxableLine();
    await waitFor(() =>
      expect(screen.getAllByText("Tax (8.25%)").length).toBeGreaterThanOrEqual(2),
    );
    expect(screen.queryByText("Tax (8%)")).toBeNull();
  });

  it("a whole-number rate stays clean", async () => {
    mockSettings = { taxRate: 10 };
    await withTaxableLine();
    await waitFor(() => expect(screen.getAllByText("Tax (10%)").length).toBeGreaterThanOrEqual(1));
  });
});
